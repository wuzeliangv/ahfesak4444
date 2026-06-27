/**
 * Reset access key modal.
 *
 * Three-stage flow with explicit recovery if any step fails:
 *
 *   1. rotating — POST /iam/keys/rotate creates a new AK at AWS (old AK
 *                 stays active). The new SK is shown by AWS only once.
 *   2. saving   — Encrypt + write the new AK/SK into the local vault.
 *                 If THIS fails, we auto-rollback by deleting the orphan
 *                 new AK using the OLD AK (which is still valid).
 *   3. deleting — POST /iam/keys/delete signed with the NEW AK. Backend
 *                 retries InvalidClientTokenId for ~15s to absorb AWS AK
 *                 propagation lag. If this fails, the rotation is still
 *                 successful from the panel's POV (new AK saved + usable),
 *                 the user just needs to clean up the old AK manually.
 *
 * The modal stays open until the user explicitly clicks 关闭, so they
 * have time to read the final state.
 */

import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Loader2,
  KeyRound,
} from 'lucide-react';
import clsx from 'clsx';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { api, ApiError } from '@/lib/api';
import { getAccountCredentials, updateAccount } from '@/lib/vault';
import { toast } from '@/lib/toast';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountAlias: string;
  /** Fires after a successful rotation so the parent can re-verify the account. */
  onRotated?: () => void;
}

type Stage = 'idle' | 'rotating' | 'saving' | 'deleting' | 'done' | 'error';

interface StepState {
  stage: Stage;
  /** Which step failed, for tailored recovery messaging. */
  errorAt: 'rotate' | 'save' | 'delete' | null;
  errorMessage: string | null;
  /** Set after a save-stage failure has been auto-rolled-back. */
  rolledBack: boolean;
  /** Set on full success. The last 4 chars of the new AK are shown. */
  newAkTail: string | null;
}

const INITIAL: StepState = {
  stage: 'idle',
  errorAt: null,
  errorMessage: null,
  rolledBack: false,
  newAkTail: null,
};

export function RotateKeyModal({
  open,
  onClose,
  accountId,
  accountAlias,
  onRotated,
}: Props) {
  const [state, setState] = useState<StepState>(INITIAL);

  // Reset whenever the modal re-opens for a different account.
  useEffect(() => {
    if (open) setState(INITIAL);
  }, [open, accountId]);

  async function runRotation() {
    setState({ ...INITIAL, stage: 'rotating' });

    // ----- 1. Rotate -------------------------------------------------------
    const oldCreds = await getAccountCredentials(accountId);
    let newAk: string;
    let newSk: string;
    try {
      const rotateResp = await api.iamKeysRotate(oldCreds);
      newAk = rotateResp.access_key;
      newSk = rotateResp.secret_key;
    } catch (e) {
      setState({
        ...INITIAL,
        stage: 'error',
        errorAt: 'rotate',
        errorMessage:
          e instanceof ApiError ? e.message : (e as Error).message || '创建新密钥失败',
      });
      return;
    }

    // ----- 2. Save to vault -----------------------------------------------
    setState((s) => ({ ...s, stage: 'saving' }));
    try {
      await updateAccount(accountId, { accessKey: newAk, secretKey: newSk });
    } catch (e) {
      // Critical: new AK exists at AWS but isn't saved locally. Try to
      // roll back by deleting it with the OLD creds (still valid).
      const saveErr =
        e instanceof Error ? e.message : '保存到本地失败';
      try {
        await api.iamKeysDelete(oldCreds, newAk);
        setState({
          ...INITIAL,
          stage: 'error',
          errorAt: 'save',
          errorMessage: saveErr,
          rolledBack: true,
        });
      } catch {
        // Rollback failed too — surface manual cleanup instructions.
        setState({
          ...INITIAL,
          stage: 'error',
          errorAt: 'save',
          errorMessage: `${saveErr} (回滚也失败,请到 AWS 控制台手动删除新密钥 ${newAk})`,
          rolledBack: false,
        });
      }
      return;
    }

    // ----- 3. Delete old AK -----------------------------------------------
    setState((s) => ({ ...s, stage: 'deleting' }));
    const newCreds = { accessKey: newAk, secretKey: newSk };
    try {
      await api.iamKeysDelete(newCreds, oldCreds.accessKey);
    } catch (e) {
      // New AK is saved + usable, just couldn't clear the old one.
      // Treat as "soft success" but warn the user.
      setState({
        ...INITIAL,
        stage: 'error',
        errorAt: 'delete',
        errorMessage:
          e instanceof ApiError ? e.message : (e as Error).message || '删除旧密钥失败',
        newAkTail: newAk.slice(-4),
      });
      toast.warning('新密钥已生效,但旧密钥未能自动删除', { duration: 5000 });
      onRotated?.();
      return;
    }

    setState({
      ...INITIAL,
      stage: 'done',
      newAkTail: newAk.slice(-4),
    });
    toast.success('密钥已重置', { duration: 3000 });
    onRotated?.();
  }

  const busy =
    state.stage === 'rotating' ||
    state.stage === 'saving' ||
    state.stage === 'deleting';

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="重置密钥"
      description={accountAlias}
      size="sm"
    >
      <div className="space-y-3">
        {/* ----- Idle: warning + confirm ------------------------------- */}
        {state.stage === 'idle' && (
          <div className="rounded-md border border-[var(--color-status-warn)]/40 bg-[var(--color-status-warn)]/10 p-3 text-xs text-[var(--color-status-warn)]">
            <ul className="list-disc space-y-1 pl-4">
              <li>将删除账号下所有密钥,并重新生成</li>
              <li>新的密钥可稍后在账号详情中查看</li>
              <li>新的密钥需要一段时间生效</li>
            </ul>
          </div>
        )}

        {/* ----- Running / Done / Error: progress steps ---------------- */}
        {state.stage !== 'idle' && (
          <div className="space-y-2 rounded-md bg-white/[0.02] p-3">
            <Step
              label="创建新密钥"
              state={stepStatusFor('rotate', state)}
            />
            <Step
              label="保存到本地"
              state={stepStatusFor('save', state)}
            />
            <Step
              label="删除旧密钥"
              state={stepStatusFor('delete', state)}
            />
          </div>
        )}

        {/* ----- Done: show new AK tail -------------------------------- */}
        {state.stage === 'done' && state.newAkTail && (
          <div className="rounded-md border border-[var(--color-status-ok)]/40 bg-[var(--color-status-ok)]/10 p-3 text-xs">
            <div className="flex items-center gap-2 font-medium text-[var(--color-status-ok)]">
              <Check size={14} />
              重置完成
            </div>
            <div className="mt-1 text-[var(--color-fg-secondary)]">
              新密钥 ID 末四位:{' '}
              <span className="font-mono tabular-nums text-[var(--color-fg-primary)]">
                …{state.newAkTail}
              </span>
            </div>
          </div>
        )}

        {/* ----- Error block ------------------------------------------- */}
        {state.stage === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-3 text-xs text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">
                {state.errorAt === 'rotate' && '创建新密钥失败'}
                {state.errorAt === 'save' &&
                  (state.rolledBack
                    ? '保存到本地失败 — 已自动回滚'
                    : '保存到本地失败')}
                {state.errorAt === 'delete' &&
                  '新密钥已生效,但旧密钥删除失败'}
              </p>
              <p className="text-[var(--color-fg-secondary)]">
                {state.errorMessage}
              </p>
              {state.errorAt === 'delete' && state.newAkTail && (
                <p className="text-[var(--color-fg-secondary)]">
                  新密钥末四位 …{state.newAkTail}。可到 IAM 控制台手动删除旧密钥。
                </p>
              )}
            </div>
          </div>
        )}

        {/* ----- Footer actions ---------------------------------------- */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            关闭
          </Button>
          {state.stage === 'idle' && (
            <Button
              type="button"
              size="sm"
              onClick={runRotation}
              leadingIcon={<KeyRound size={12} />}
            >
              重置
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

function stepStatusFor(step: 'rotate' | 'save' | 'delete', s: StepState): StepStatus {
  // ---- Done state: all 3 steps succeeded ---------------------------------
  if (s.stage === 'done') return 'done';

  // ---- Error states: the failing step gets 'error', earlier steps 'done',
  // later steps 'skipped'.
  if (s.stage === 'error') {
    if (s.errorAt === step) return 'error';
    const order = ['rotate', 'save', 'delete'] as const;
    const errIdx = s.errorAt ? order.indexOf(s.errorAt) : -1;
    const myIdx = order.indexOf(step);
    if (errIdx < 0 || myIdx < errIdx) return 'done';
    return 'skipped';
  }

  // ---- In-flight states: completed steps are 'done', current is 'running' --
  if (s.stage === 'rotating') {
    return step === 'rotate' ? 'running' : 'pending';
  }
  if (s.stage === 'saving') {
    if (step === 'rotate') return 'done';
    if (step === 'save') return 'running';
    return 'pending';
  }
  if (s.stage === 'deleting') {
    if (step === 'delete') return 'running';
    return 'done';
  }
  return 'pending';
}

function Step({ label, state }: { label: string; state: StepStatus }) {
  const icon = (() => {
    switch (state) {
      case 'done':
        return <Check size={12} className="text-[var(--color-status-ok)]" />;
      case 'running':
        return <Loader2 size={12} className="animate-spin text-[var(--color-accent-300)]" />;
      case 'error':
        return <AlertCircle size={12} className="text-[var(--color-status-error)]" />;
      case 'skipped':
        return (
          <span className="inline-block size-[10px] rounded-full border border-[var(--color-fg-muted)]/50" />
        );
      default:
        return (
          <span className="inline-block size-[10px] rounded-full border border-[var(--color-border-glass)]" />
        );
    }
  })();
  return (
    <div
      className={clsx(
        'flex items-center gap-2 text-xs',
        state === 'pending' && 'text-[var(--color-fg-muted)]',
        state === 'running' && 'text-[var(--color-fg-primary)]',
        state === 'done' && 'text-[var(--color-fg-secondary)]',
        state === 'error' && 'text-[var(--color-status-error)]',
        state === 'skipped' && 'text-[var(--color-fg-muted)]/60',
      )}
    >
      <span className="inline-flex size-4 items-center justify-center">{icon}</span>
      {label}
    </div>
  );
}
