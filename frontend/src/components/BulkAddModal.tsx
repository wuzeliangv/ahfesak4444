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

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, X as XIcon } from 'lucide-react';
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

    // 1. Pull out the AK first (AK chars are a subset of SK chars).
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

    // 2. Then a 40-char SK in whatever remains.
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

    // 3. Optional region — default Virginia handled downstream.
    let region: string | undefined;
    const regionMatch = line.match(REGION_RE);
    if (regionMatch) {
      region = regionMatch[0];
      line = line.replace(region, ' ');
    }

    // 4. Anything left is the alias — collapse separators, trim.
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

    const { rows, invalid } = parse(text);
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
        const v = await api.verify({ accessKey: row.accessKey, secretKey: row.secretKey });
        const verified: AccountInput['verified'] = {
          accountId: v.account_id,
          arn: v.arn,
          iamAlias: v.alias,
          isRoot: v.is_root,
          akPrefix: v.ak_prefix,
          countryCode: v.country_code,
          accountCreatedAt: v.created_at,
        };
        const alias = row.alias?.trim() || v.alias || v.account_id;
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
          accountId: v.account_id,
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
      title="批量添加账号"
      description="每行一个账号,凭证将逐个通过 AWS 验证后再加密保存"
      size="lg"
    >
      {results ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="flex items-center gap-1 text-green-500">
              <Check size={14} /> 成功 {okCount}
            </span>
            <span className="flex items-center gap-1 text-[var(--color-status-error)]">
              <XIcon size={14} /> 失败 {failCount}
            </span>
          </div>
          <ul className="max-h-72 overflow-y-auto rounded-lg border border-[var(--color-border-glass)] divide-y divide-[var(--color-border-glass)]">
            {results.map((r) => (
              <li key={r.line} className="flex items-start gap-2 px-3 py-2 text-sm">
                <span
                  className={
                    r.status === 'ok'
                      ? 'mt-0.5 text-green-500'
                      : 'mt-0.5 text-[var(--color-status-error)]'
                  }
                >
                  {r.status === 'ok' ? <Check size={14} /> : <XIcon size={14} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block">
                    <span className="font-mono text-[var(--color-fg-muted)]">第 {r.line} 行</span>{' '}
                    — <span className="truncate">{r.alias}</span>
                    {r.accountId && (
                      <span className="ml-1 font-mono text-xs text-[var(--color-fg-muted)]">
                        ({r.accountId})
                      </span>
                    )}
                  </span>
                  {r.message && (
                    <span className="block text-xs text-[var(--color-status-error)]">
                      {r.message}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={reset}>
              继续粘贴
            </Button>
            <Button type="button" onClick={handleClose}>
              完成
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--color-fg-secondary)]">
              账号列表
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="glass-input block min-h-[180px] w-full resize-y px-3 py-2 font-mono text-xs outline-none"
              placeholder={`# 智能识别:每行一个账号,AK / SK / 区域 / 账号名顺序随意
# 区域不填默认 us-east-1(美国弗吉尼亚)
小号A   AKIAxxxxxxxxxxxxxxxx   xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AKIAxxxxxxxxxxxxxxxx,xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
日本东京小号B ap-northeast-1 AKIAxxxxxxxxxxxxxxxx xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`}
              spellCheck={false}
              autoComplete="off"
              disabled={running}
            />
            <p className="mt-1.5 text-xs text-[var(--color-fg-muted)]">
              自动识别 AK(AKIA/ASIA 开头 20 位)、SK(40 位)、区域(如 us-east-1)。
              剩余的文字会当作账号名,顺序、分隔符(空格 / 逗号 / Tab)都不重要。
              区域不填默认 us-east-1(美国弗吉尼亚)。
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--color-status-error)]/40 bg-[var(--color-status-error)]/10 p-3 text-xs text-[var(--color-status-error)]">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {progress && (
            <p className="text-xs text-[var(--color-fg-muted)]">
              正在验证 {progress.done}/{progress.total}…
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={handleClose} disabled={running}>
              取消
            </Button>
            <Button type="submit" loading={running}>
              验证并添加
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
