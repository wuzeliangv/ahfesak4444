/**
 * Bedrock / Claude permissions modal.
 *
 * Sections (top → bottom):
 *   1. SageMaker notebook quota — single line, applied / default.
 *   2. Claude Opus models — 3 fixed entries (4.6, 4.7, 4.8), each with
 *      "applied / default" tags for Daily / TPM / (RPM if applicable).
 *
 * Region is fixed to us-east-1 — quotas are per-region but the three
 * Opus models are surfaced uniformly there.
 */

import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { api, type BedrockOpusModel, type BedrockQuotaPair } from '@/lib/api';
import { getAccountCredentials } from '@/lib/vault';

interface Props {
  open: boolean;
  onClose: () => void;
  accountId: string;
  accountAlias: string;
}

const BEDROCK_REGION = 'us-east-1';

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/**
 * Format a raw token count as "<n>M" (millions). Bedrock quotas live in
 * the millions, so the M scale is the natural unit. Anything below 1M
 * collapses to "0M" to match the design spec.
 */
function fmtTokensM(n: number | null | undefined): string {
  if (n == null) return '-';
  const m = n / 1_000_000;
  if (m < 0.01) return '0M';
  if (m >= 100) return `${Math.round(m)}M`;
  if (m >= 10) return `${m.toFixed(1).replace(/\.0$/, '')}M`;
  return `${m.toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** Plain count formatting — used for RPM (no M scaling). */
function fmtCount(n: number | null | undefined): string {
  if (n == null) return '-';
  return n.toLocaleString();
}

function pairTagTokens(p: BedrockQuotaPair, prefix = ''): string {
  return `${prefix}${fmtTokensM(p.applied)} / ${fmtTokensM(p.default)}`;
}

function pairTagCount(p: BedrockQuotaPair, prefix = ''): string {
  return `${prefix}${fmtCount(p.applied)} / ${fmtCount(p.default)}`;
}

function buildTags(m: BedrockOpusModel): string[] {
  const tags: string[] = [
    pairTagTokens(m.daily),
    pairTagTokens(m.tpm, 'TPM: '),
  ];
  if (m.rpm) {
    tags.push(pairTagCount(m.rpm, 'RPM: '));
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BedrockModal({ open, onClose, accountId, accountAlias }: Props) {
  const q = useQuery({
    enabled: open,
    queryKey: ['bedrock-info', accountId, BEDROCK_REGION],
    retry: false,
    staleTime: 60 * 1000,
    queryFn: async ({ signal }) => {
      const creds = await getAccountCredentials(accountId);
      return api.bedrockInfo(creds, BEDROCK_REGION, signal);
    },
  });

  const data = q.data;

  return (
    <Modal open={open} onClose={onClose} title="Bedrock 权限" description={accountAlias} size="sm">
      <div className="space-y-3">
        {/* ---- Loading ------------------------------------------------- */}
        {q.isLoading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--color-fg-muted)]">
            <Loader2 size={14} className="animate-spin" />
            正在查询 Bedrock 配额…
          </div>
        )}

        {/* ---- Error --------------------------------------------------- */}
        {q.isError && (
          <div className="flex items-start gap-2 rounded-md border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-3 text-sm text-[var(--color-status-error)]">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>{(q.error as Error).message || '查询失败'}</span>
          </div>
        )}

        {/* ---- Data ---------------------------------------------------- */}
        {data && (
          <>
            {/* 1. Sagemaker notebook quota */}
            <div className="flex items-center justify-between rounded-md bg-white/[0.02] p-3">
              <span className="text-sm text-[var(--color-fg-primary)]">
                Sagemaker notebook 配额
              </span>
              <span className="rounded bg-emerald-500/15 px-2 py-1 text-sm font-medium tabular-nums text-emerald-400">
                {fmtCount(data.sagemaker_notebook.applied)}
              </span>
            </div>

            {/* 2. Models */}
            <div>
              <h3 className="mb-2 text-sm font-bold text-[var(--color-fg-primary)]">
                模型
              </h3>
              <div className="space-y-3">
                {data.claude_opus_models.map((m) => (
                  <div
                    key={m.id}
                    className="space-y-2 rounded-md bg-white/[0.02] p-3"
                  >
                    {/* Row 1: bullet + name */}
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--color-fg-muted)]">•</span>
                      <span className="text-sm font-semibold text-[var(--color-fg-primary)]">
                        {m.name}
                      </span>
                    </div>

                    {/* Row 2: model id */}
                    <div className="break-all font-mono text-[11px] leading-snug text-[var(--color-fg-muted)]">
                      {m.id}
                    </div>

                    {/* Row 3: applied/default tags */}
                    <div className="flex flex-wrap gap-2">
                      {buildTags(m).map((t) => (
                        <span
                          key={t}
                          className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] tabular-nums text-emerald-400"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
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
