/**
 * 批量添加账号 — paste many AK/SK rows at once, verify each, add the
 * successful ones to the vault. Same per-account flow as the single-add
 * form: API verify → cache identity metadata → encrypt + persist.
 *
 * Smart parser (per-line, order-insensitive):
 *   - AK     detected by /A[KS]IA[A-Z0-9]{16}/ (long-term AKIA / STS ASIA)
 *   - SK     detected by /[A-Za-z0-9+/=]{40}/  (40-char base64-ish secret)
 *   - 区域    detected by /[a-z]{2}-[a-z]+-\d/  (e.g. us-east-1)
 *   - 账号名  = whatever non-empty text remains on the line
 *
 * Each line = one account. Region defaults to us-east-1 when absent.
 * Blank lines and lines starting with '#' are skipped. Verifies sequentially
 * to avoid AWS throttling.
 */

import { useState, useMemo, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, X as XIcon, FileText, Zap, Loader2, Sparkles } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { addAccount, type AccountInput } from '@/lib/vault';
import { api, ApiError } from '@/lib/api';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ParsedRow {
  line: number;
  alias?: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

interface RowResult {
  line: number;
  status: 'ok' | 'failed' | 'invalid';
  alias: string;
  accountId?: string;
  message?: string;
}

const AK_RE = /\bA[KS]IA[A-Z0-9]{16}\b/;
const SK_RE = /[A-Za-z0-9+/=]{40}/;
const REGION_RE = /\b[a-z]{2}-[a-z]+-\d\b/;

function parse(text: string): { rows: ParsedRow[]; invalid: RowResult[] } {
  const rows: ParsedRow[] = [];
  const invalid: RowResult[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const lineNo = i + 1;
    const original = line;

    // 1. Pull out the AK first
    const akMatch = line.match(AK_RE);
    if (!akMatch) {
      invalid.push({
        line: lineNo,
        status: 'invalid',
        alias: original.slice(0, 40),
        message: '未找到 Access Key (应以 AKIA / ASIA 开头,共 20 位)',
      });
      continue;
    }
    const accessKey = akMatch[0];
    line = line.replace(accessKey, ' ');

    // 2. Then a 40-char SK
    const skMatch = line.match(SK_RE);
    if (!skMatch) {
      invalid.push({
        line: lineNo,
        status: 'invalid',
        alias: original.slice(0, 40),
        message: '未找到 Secret Key (40 位字符)',
      });
      continue;
    }
    const secretKey = skMatch[0];
    line = line.replace(secretKey, ' ');

    // 3. Optional region
    let region: string | undefined;
    const regionMatch = line.match(REGION_RE);
    if (regionMatch) {
      region = regionMatch[0];
      line = line.replace(region, ' ');
    }

    // 4. Anything left is the alias
    const alias = line.replace(/[,\t]+/g, ' ').trim().replace(/\s+/g, ' ') || undefined;

    rows.push({ line: lineNo, alias, accessKey, secretKey, region });
  }
  return { rows, invalid };
}

export function BulkAddModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<RowResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live parsing
  const { rows, invalid } = useMemo(() => parse(text), [text]);

  function reset() {
    setText('');
    setResults(null);
    setProgress(null);
    setError(null);
  }

  function handleClose() {
    if (running) return;
    reset();
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setResults(null);

    if (rows.length === 0 && invalid.length === 0) {
      setError('请粘贴至少一行账号');
      return;
    }

    setRunning(true);
    setProgress({ done: 0, total: rows.length });

    const out: RowResult[] = [...invalid];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        let verified: AccountInput['verified'] | undefined;
        let accountId: string | undefined;
        let iamAlias: string | undefined;

        try {
          const v = await api.verify({ accessKey: row.accessKey, secretKey: row.secretKey });
          verified = {
            accountId: v.account_id,
            arn: v.arn,
            iamAlias: v.alias,
            isRoot: v.is_root,
            akPrefix: v.ak_prefix,
            countryCode: v.country_code,
            accountCreatedAt: v.created_at,
          };
          accountId = v.account_id;
          iamAlias = v.alias ?? undefined;
        } catch (verr) {
          if (verr instanceof ApiError && verr.code === 'NotConfigured') {
            // No backend yet -> bypass validation and add blindly
            verified = undefined;
          } else {
            throw verr; // Bubble up other errors (like InvalidCredentials)
          }
        }

        const alias = row.alias?.trim() || iamAlias || accountId || `AWS_Acc_${row.accessKey.slice(0,6)}`;
        await addAccount({
          alias,
          accessKey: row.accessKey,
          secretKey: row.secretKey,
          defaultRegion: row.region || 'us-east-1',
          verified,
        });

        out.push({
          line: row.line,
          status: 'ok',
          alias,
          accountId,
        });
      } catch (e) {
        const msg =
          e instanceof ApiError && e.code === 'InvalidCredentials'
            ? 'AWS 拒绝了这对 AK/SK'
            : (e as Error).message;
        out.push({
          line: row.line,
          status: 'failed',
          alias: row.alias ?? row.accessKey.slice(0, 12),
          message: msg,
        });
      }
      setProgress({ done: i + 1, total: rows.length });
    }

    setRunning(false);
    setResults(out.sort((a, b) => a.line - b.line));
    await qc.invalidateQueries({ queryKey: ['accounts'] });
  }

  const okCount = (results ?? []).filter((r) => r.status === 'ok').length;
  const failCount = (results ?? []).filter((r) => r.status !== 'ok').length;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={
        <div className="flex items-center gap-2">
          <Sparkles className="text-[var(--color-primary-main)]" size={18} />
          <span>批量导入账号</span>
        </div>
      }
      description="每行一个账号，我们将智能识别并逐个验证加密保存。一次搞定您的所有小号集群。"
      size="lg"
    >
      {results ? (
        <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--color-bg-elevated)] border border-[var(--color-border-glass)]">
            <div className="flex items-center gap-4 text-sm font-medium">
              <span className="flex items-center gap-1.5 text-green-500">
                <div className="p-1 rounded-full bg-green-500/10">
                  <Check size={14} />
                </div>
                成功导入 {okCount}
              </span>
              <span className="flex items-center gap-1.5 text-[var(--color-status-error)]">
                <div className="p-1 rounded-full bg-[var(--color-status-error)]/10">
                  <XIcon size={14} />
                </div>
                失败 {failCount}
              </span>
            </div>
            <div className="text-xs text-[var(--color-fg-muted)]">
              共处理 {results.length} 行
            </div>
          </div>

          <ul className="max-h-[300px] overflow-y-auto rounded-xl border border-[var(--color-border-glass)] divide-y divide-[var(--color-border-glass)] bg-[var(--color-bg-base)]/50 backdrop-blur-sm">
            {results.map((r) => (
              <li key={r.line} className="flex items-start gap-3 p-3 text-sm hover:bg-[var(--color-bg-elevated)]/50 transition-colors">
                <span
                  className={
                    r.status === 'ok'
                      ? 'mt-0.5 text-green-500'
                      : 'mt-0.5 text-[var(--color-status-error)]'
                  }
                >
                  {r.status === 'ok' ? <Check size={16} /> : <XIcon size={16} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center flex-wrap gap-x-2">
                    <span className="inline-flex items-center justify-center bg-[var(--color-bg-elevated)] px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--color-fg-muted)] border border-[var(--color-border-glass)]">
                      L{r.line}
                    </span>
                    <span className="font-medium truncate">{r.alias}</span>
                    {r.accountId && (
                      <span className="font-mono text-xs text-[var(--color-primary-main)] bg-[var(--color-primary-main)]/10 px-1.5 py-0.5 rounded">
                        {r.accountId}
                      </span>
                    )}
                  </span>
                  {r.message && (
                    <span className="block mt-1 text-xs text-[var(--color-status-error)] font-medium">
                      {r.message}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={reset}>
              继续粘贴
            </Button>
            <Button type="button" onClick={handleClose}>
              完成
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-secondary)] flex items-center gap-1.5">
                <FileText size={14} /> 账号列表
              </span>
              {(rows.length > 0 || invalid.length > 0) && (
                <div className="flex items-center gap-3 text-xs animate-in fade-in">
                  {rows.length > 0 && (
                    <span className="text-green-500 flex items-center gap-1">
                      <Check size={12} /> 识别 {rows.length}
                    </span>
                  )}
                  {invalid.length > 0 && (
                    <span className="text-amber-500 flex items-center gap-1">
                      <AlertCircle size={12} /> 格式错误 {invalid.length}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="relative group">
              <div className="absolute -inset-0.5 rounded-xl bg-gradient-to-br from-[var(--color-primary-main)] to-purple-500 opacity-[0.15] blur group-focus-within:opacity-30 transition-opacity duration-500"></div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="relative glass-input block min-h-[220px] w-full resize-y rounded-xl px-4 py-3 font-mono text-xs leading-relaxed text-[var(--color-fg-primary)] outline-none placeholder-[var(--color-fg-muted)]/50 focus:ring-1 focus:ring-[var(--color-primary-main)]/50"
                placeholder={`# 智能提取:每行一个账号,AK/SK/区域/账号名顺序随意
# 区域不填默认 us-east-1(美国弗吉尼亚)

小号A   AKIAxxxxxxxxxxxxxxxx   xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AKIAxxxxxxxxxxxxxxxx,xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
日本东京小号B ap-northeast-1 AKIAxxxxxxxxxxxxxxxx xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`}
                spellCheck={false}
                autoComplete="off"
                disabled={running}
              />
            </div>
            
            <div className="mt-3 flex items-start gap-2 p-3 rounded-lg bg-[var(--color-primary-main)]/5 border border-[var(--color-primary-main)]/10">
              <Zap size={14} className="mt-0.5 text-[var(--color-primary-main)] shrink-0" />
              <p className="text-[11px] leading-snug text-[var(--color-fg-muted)]">
                自动提取 <span className="text-[var(--color-fg-primary)] font-mono">AKIA/ASIA</span>(20位) 
                与 <span className="text-[var(--color-fg-primary)] font-mono">Secret Key</span>(40位)。
                可自动识别区域代码(如 <span className="text-[var(--color-fg-primary)] font-mono">us-east-1</span>)。
                剩余文字将作为账号名保存，顺序/分隔符随意。
              </p>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-3 text-sm text-[var(--color-status-error)] animate-in shake">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <div>
              {running && progress && (
                <div className="flex items-center gap-2 text-sm text-[var(--color-primary-main)] animate-in fade-in">
                  <Loader2 size={14} className="animate-spin" />
                  <span>正在验证并加密 ({progress.done}/{progress.total})…</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button type="button" variant="ghost" onClick={handleClose} disabled={running}>
                取消
              </Button>
              <Button type="submit" disabled={running || (rows.length === 0 && text.length > 0)} className="min-w-[120px]">
                {running ? '处理中...' : (rows.length > 0 ? `导入 ${rows.length} 个账号` : '验证并添加')}
              </Button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  );
}
