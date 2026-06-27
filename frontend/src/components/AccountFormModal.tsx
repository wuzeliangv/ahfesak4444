/**
 * Add / edit an AWS account.
 *
 * On submit:
 *   1. Call POST /accounts/verify with the entered AK/SK.
 *      - If AWS rejects them we show an inline error and keep the form open.
 *      - If they verify, we cache the returned identity metadata.
 *   2. Persist via vault.addAccount / vault.updateAccount (encrypts AK/SK).
 *   3. Invalidate the account list query so the parent re-renders.
 *
 * The Secret Key field is masked by default with a show/hide toggle.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, AlertCircle, KeyRound, Lock, MapPin, Tag, Layers, Share2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { addAccount, listGroups, updateAccount, type AccountInput } from '@/lib/vault';
import { type AccountRecord } from '@/lib/db';
import { api, ApiError } from '@/lib/api';
import { REGIONS, regionInfo } from '@/lib/regions';
import { listDeployments } from '@/lib/deployer';

interface Props {
  open: boolean;
  onClose: () => void;
  /** When provided, the modal is in edit mode. */
  account?: AccountRecord;
}

export function AccountFormModal({ open, onClose, account }: Props) {
  const qc = useQueryClient();
  const isEdit = !!account;
  const groupsQ = useQuery({ queryKey: ['groups'], queryFn: listGroups, enabled: open });
  const groups = groupsQ.data ?? [];

  // Available egress nodes (regions that have a deployed worker).
  const depQ = useQuery({
    queryKey: ['deployments'],
    queryFn: () => listDeployments(),
    enabled: open,
  });
  const nodeRegions = [
    ...new Set((depQ.data?.deployments ?? []).map((d) => d.region)),
  ].sort();

  const [alias, setAlias] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [defaultRegion, setDefaultRegion] = useState('us-east-1');
  const [group, setGroup] = useState('');
  const [note, setNote] = useState('');
  const [pinnedRegion, setPinnedRegion] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repopulate fields when (re)opening for editing.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setShowSecret(false);
    if (account) {
      setAlias(account.alias);
      setAccessKey('');                      // never display existing AK
      setSecretKey('');                      // never display existing SK
      setDefaultRegion(account.defaultRegion);
      setGroup(account.group ?? '');
      setNote(account.note ?? '');
      setPinnedRegion(account.pinnedRegion ?? '');
    } else {
      setAlias('');
      setAccessKey('');
      setSecretKey('');
      setDefaultRegion('us-east-1');
      setGroup('');
      setNote('');
      setPinnedRegion('');
    }
  }, [open, account]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Edit mode: AK/SK only re-encrypted if provided
    const credsProvided = accessKey.length > 0 || secretKey.length > 0;
    if (!isEdit && !credsProvided) {
      setError('请填写 Access Key 与 Secret Key');
      return;
    }
    if (credsProvided && (!accessKey || !secretKey)) {
      setError('Access Key 与 Secret Key 必须同时填写');
      return;
    }

    setSubmitting(true);
    try {
      let verified: AccountInput['verified'] | undefined;

      if (credsProvided) {
        // Verify before persisting — fail fast on bad credentials
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
      }

      if (isEdit && account) {
        await updateAccount(account.id, {
          alias,
          defaultRegion,
          group: group || undefined,
          note: note || undefined,
          pinnedRegion: pinnedRegion || null,
          accessKey: credsProvided ? accessKey : undefined,
          secretKey: credsProvided ? secretKey : undefined,
          verified,
        });
      } else {
        await addAccount({
          alias,
          accessKey,
          secretKey,
          defaultRegion,
          group: group || undefined,
          note: note || undefined,
          pinnedRegion: pinnedRegion || null,
          verified,
        });
      }

      await qc.invalidateQueries({ queryKey: ['accounts'] });
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
      title={isEdit ? '编辑账号' : '添加 AWS 账号'}
      description={
        isEdit
          ? '留空 AK / SK 表示保留现有凭证'
          : '凭证将通过 AWS 验证后再保存'
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Input
          label="账号 / 邮箱"
          name="alias"
          autoFocus
          required
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="例如:aws-login@example.com 或 测试小号 1"
          leadingIcon={<Tag size={14} />}
        />

        <Input
          label="Access Key"
          name="access-key"
          required={!isEdit}
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
          required={!isEdit}
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

        <div>
          <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--color-fg-secondary)]">
            出口节点 (可选)
          </span>
          <span className="glass-input flex items-center gap-2 px-3 h-10">
            <Share2 size={14} className="text-[var(--color-fg-muted)]" />
            <select
              value={pinnedRegion}
              onChange={(e) => setPinnedRegion(e.target.value)}
              disabled={nodeRegions.length === 0}
              className="flex-1 bg-transparent border-0 text-sm outline-none disabled:opacity-60"
            >
              <option value="" className="bg-[var(--color-bg-deep)]">
                自动 (按操作区域就近)
              </option>
              {/* keep the current pin selectable even if its node is gone */}
              {pinnedRegion && !nodeRegions.includes(pinnedRegion) && (
                <option value={pinnedRegion} className="bg-[var(--color-bg-deep)]">
                  {regionInfo(pinnedRegion).label} ({pinnedRegion}) (无节点)
                </option>
              )}
              {nodeRegions.map((r) => (
                <option key={r} value={r} className="bg-[var(--color-bg-deep)]">
                  {regionInfo(r).label} ({r})
                </option>
              ))}
            </select>
          </span>
          <span className="mt-1.5 block text-xs text-[var(--color-fg-muted)]">
            {nodeRegions.length === 0
              ? '还没有部署节点;在 Lambda 页部署后即可为该账号固定出口。'
              : '固定后,该账号的所有请求都从所选区域的节点 IP 发出。'}
          </span>
        </div>

        {groups.length > 0 && (
          <div>
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--color-fg-secondary)]">
              分组 (可选)
            </span>
            <span className="glass-input flex items-center gap-2 px-3 h-10">
              <Layers size={14} className="text-[var(--color-fg-muted)]" />
              <select
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                className="flex-1 bg-transparent border-0 text-sm outline-none"
              >
                <option value="" className="bg-[var(--color-bg-deep)]">未分组</option>
                {groups.map((g) => (
                  <option key={g.name} value={g.name} className="bg-[var(--color-bg-deep)]">
                    {g.name}
                  </option>
                ))}
                {/* Orphan: the account's current group string no longer exists */}
                {group && !groups.some((g) => g.name === group) && (
                  <option value={group} className="bg-[var(--color-bg-deep)]">
                    {group} (已删除)
                  </option>
                )}
              </select>
            </span>
          </div>
        )}

        <Input
          label="备注 (可选)"
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="留给自己看的说明,例如 KDDI"
        />

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
            {isEdit ? '保存' : '验证并添加'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
