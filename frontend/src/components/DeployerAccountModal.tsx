/**
 * Add a deployer account — an AWS account used to HOST worker Lambdas on the
 * Lambda 节点部署 page. Stored separately from dashboard accounts.
 *
 * On submit we verify the AK/SK via /accounts/verify (fail fast on bad keys
 * and capture the account id for display), then persist via
 * vault.addDeployerAccount and invalidate the ['deployer-accounts'] query.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, AlertCircle, KeyRound, Lock, MapPin, Tag } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { addDeployerAccount, type DeployerAccountInput } from '@/lib/vault';
import { api, ApiError } from '@/lib/api';
import { REGIONS } from '@/lib/regions';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DeployerAccountModal({ open, onClose }: Props) {
  const qc = useQueryClient();

  const [alias, setAlias] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [defaultRegion, setDefaultRegion] = useState('us-east-1');
  const [showSecret, setShowSecret] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setShowSecret(false);
    setAlias('');
    setAccessKey('');
    setSecretKey('');
    setDefaultRegion('us-east-1');
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!accessKey || !secretKey) {
      setError('请填写 Access Key 与 Secret Key');
      return;
    }
    setSubmitting(true);
    try {
      let verified: DeployerAccountInput['verified'] | undefined;
      try {
        const v = await api.verify({ accessKey, secretKey });
        verified = {
          accountId: v.account_id,
          arn: v.arn,
          iamAlias: v.alias,
          isRoot: v.is_root,
          akPrefix: v.ak_prefix,
          countryCode: v.country_code,
          accountCreatedAt: v.created_at,
        };
      } catch (e) {
        if (e instanceof ApiError && e.code === 'InvalidCredentials') {
          setError('AWS 拒绝了这对 AK/SK,请检查');
        } else {
          setError(`验证失败:${(e as Error).message}`);
        }
        return;
      }

      await addDeployerAccount({
        alias: alias.trim() || verified?.accountId || 'deployer',
        accessKey,
        secretKey,
        defaultRegion,
        verified,
      });
      await qc.invalidateQueries({ queryKey: ['deployer-accounts'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="添加部署账号"
      description="仅用于部署 Lambda 节点,与主账号列表分开保存。凭证将通过 AWS 验证后再保存。"
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Input
          label="账号名 / 备注"
          name="alias"
          autoFocus
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="例如:部署专用-A(留空则用账号 ID)"
          leadingIcon={<Tag size={14} />}
        />
        <Input
          label="Access Key"
          name="access-key"
          required
          value={accessKey}
          onChange={(e) => setAccessKey(e.target.value)}
          placeholder="AKIA..."
          autoComplete="off"
          spellCheck={false}
          leadingIcon={<KeyRound size={14} />}
        />
        <Input
          label="Secret Key"
          name="secret-key"
          type={showSecret ? 'text' : 'password'}
          required
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          placeholder="••••••••••••••••••••••"
          autoComplete="off"
          spellCheck={false}
          leadingIcon={<Lock size={14} />}
          trailingSlot={
            <button
              type="button"
              onClick={() => setShowSecret((s) => !s)}
              className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
              aria-label={showSecret ? '隐藏' : '显示'}
              tabIndex={-1}
            >
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          }
        />
        <div>
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--color-fg-secondary)]">
            默认 Region
          </span>
          <span className="glass-input flex items-center gap-2 px-3 h-10">
            <MapPin size={14} className="text-[var(--color-fg-muted)]" />
            <select
              value={defaultRegion}
              onChange={(e) => setDefaultRegion(e.target.value)}
              className="flex-1 bg-transparent border-0 text-sm outline-none"
            >
              {REGIONS.map((r) => (
                <option key={r.code} value={r.code} className="bg-[var(--color-bg-deep)]">
                  {r.code} — {r.label}
                </option>
              ))}
            </select>
          </span>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-3 text-xs text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" loading={submitting}>
            验证并添加
          </Button>
        </div>
      </form>
    </Modal>
  );
}
