/**
 * IAM federation sign-in modal.
 *
 * Generates a 1-hour AWS Console sign-in URL via `sts:GetFederationToken`
 * and renders it for the user to open or copy.
 *
 * UX:
 *   1. Modal opens with informational notes about the link.
 *   2. User clicks "生成链接" — backend mints a fresh federation URL.
 *   3. Result section shows the URL with two actions:
 *        - 点击链接   : opens in new tab (target=_blank)
 *        - 复制链接   : copies to clipboard for use in incognito mode etc.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertCircle, Check, Copy, ExternalLink, Info, Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { api, type SigninUrlData } from '@/lib/api';
import { getAccountCredentials } from '@/lib/vault';
import { toast } from '@/lib/toast';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountAlias: string;
}

export function IamSigninModal({ open, onClose, accountId, accountAlias }: Props) {
  const [result, setResult] = useState<SigninUrlData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      const creds = await getAccountCredentials(accountId);
      return api.iamSigninUrl(creds);
    },
    onSuccess: (data) => {
      setResult(data);
      setError(null);
    },
    onError: (err) => {
      setError((err as Error).message ?? '生成失败');
      setResult(null);
    },
  });

  // Reset state every time modal re-opens for a different account.
  function reset() {
    setResult(null);
    setError(null);
    setCopied(false);
  }

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('链接已复制', { duration: 1500 });
    } catch {
      toast.error('剪贴板不可用,请手动选中链接复制');
    }
  }

  function handleClose() {
    reset();
    onClose();
  }

  const busy = mutation.isPending;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="IAM 登录"
      description={accountAlias}
      size="sm"
    >
      <div className="space-y-3">
        {/* Informational notes */}
        <ul className="space-y-1.5 rounded-md bg-white/[0.02] p-3 text-xs text-[var(--color-fg-secondary)]">
          <Note>IAM 登录链接有效期为 1 小时</Note>
          <Note>IAM 登录部分控制台功能无法使用</Note>
          <Note>使用账单功能请先在主账号控制台启用 IAM 用户账单权限</Note>
        </ul>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-2.5 text-sm text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Result: URL + actions */}
        {result && (
          <div className="space-y-2 rounded-md bg-white/[0.02] p-3">
            <div className="text-[11px] text-[var(--color-fg-secondary)]">登录链接</div>
            <div
              className="break-all rounded bg-[var(--color-bg-base)] px-2 py-1.5 font-mono text-[10px] leading-tight text-[var(--color-fg-secondary)]"
              title={result.url}
            >
              {result.url}
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="!h-7 !px-2 !gap-1 text-[11px]"
                onClick={() =>
                  window.open(result.url, '_blank', 'noopener,noreferrer')
                }
              >
                <ExternalLink size={12} />
                点击链接
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="!h-7 !px-2 !gap-1 text-[11px]"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check size={12} className="text-green-500" />
                ) : (
                  <Copy size={12} />
                )}
                {copied ? '已复制' : '复制链接'}
              </Button>
            </div>
          </div>
        )}

        {/* Footer actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
            关闭
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => mutation.mutate()}
            loading={busy}
            disabled={busy}
          >
            {busy ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                生成中…
              </>
            ) : result ? (
              '重新生成'
            ) : (
              '生成链接'
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-1.5">
      <Info size={11} className="mt-[2px] shrink-0 text-[var(--color-fg-muted)]" />
      <span>{children}</span>
    </li>
  );
}
