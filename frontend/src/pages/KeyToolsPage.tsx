import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  KeyRound,
  Copy,
  Loader2,
  Sparkles,
  CheckCircle2,
  XCircle,
  FileText,
  FileDown,
} from 'lucide-react';
import clsx from 'clsx';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { usePageTitle } from '@/hooks/usePageTitle';

interface ParsedRow {
  line: number;
  originalText: string;
  remark: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

interface ProcessResult {
  line: number;
  originalText: string;
  remark: string;
  accessKey: string;
  secretKey: string;
  status: 'idle' | 'pending' | 'ok' | 'failed';
  details: string;
  newAccessKey?: string;
  newSecretKey?: string;
}

const AK_RE = /\bA[KS]IA[A-Z0-9]{16}\b/;
const SK_RE = /[A-Za-z0-9+/=]{40}/;
const REGION_RE = /\b[a-z]{2}-[a-z]+-\d\b/;

function parseKeys(text: string): { rows: ParsedRow[]; invalidLines: number[] } {
  const rows: ParsedRow[] = [];
  const invalidLines: number[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const lineNo = i + 1;
    const originalText = lines[i];

    // 1. Extract AK
    const akMatch = line.match(AK_RE);
    if (!akMatch) {
      invalidLines.push(lineNo);
      continue;
    }
    const accessKey = akMatch[0];
    line = line.replace(accessKey, ' ');

    // 2. Extract SK
    const skMatch = line.match(SK_RE);
    if (!skMatch) {
      invalidLines.push(lineNo);
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

    // 4. Remaining text is remark
    const remark = line.replace(/[,\t]+/g, ' ').trim().replace(/\s+/g, ' ');

    rows.push({
      line: lineNo,
      originalText,
      remark,
      accessKey,
      secretKey,
      region,
    });
  }

  return { rows, invalidLines };
}

export function KeyToolsPage() {
  usePageTitle('密钥工具箱');
  const navigate = useNavigate();

  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [currentOp, setCurrentOp] = useState<'verify' | 'rotate' | 'quota' | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<ProcessResult[]>([]);
  const [activeTab, setActiveTab] = useState<'progress' | 'export'>('progress');

  const { rows, invalidLines } = useMemo(() => parseKeys(text), [text]);

  // Sync results state with rows when text changes (only if not running)
  useEffect(() => {
    if (!running) {
      setResults(
        rows.map((r) => ({
          line: r.line,
          originalText: r.originalText,
          remark: r.remark,
          accessKey: r.accessKey,
          secretKey: r.secretKey,
          status: 'idle',
          details: '',
        }))
      );
    }
  }, [rows, running]);

  // Batch runner helper (concurrency limit = 5)
  async function runBatch(
    items: ParsedRow[],
    fn: (row: ParsedRow) => Promise<{ status: 'ok' | 'failed'; details: string; newAK?: string; newSK?: string }>
  ) {
    const BATCH_SIZE = 5;
    const total = items.length;
    setProgress({ done: 0, total });

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const chunk = items.slice(i, i + BATCH_SIZE);

      // Set chunk items status to pending
      setResults((prev) =>
        prev.map((res) => {
          const inChunk = chunk.some((c) => c.line === res.line);
          if (inChunk) return { ...res, status: 'pending' };
          return res;
        })
      );

      await Promise.all(
        chunk.map(async (row) => {
          try {
            const out = await fn(row);
            setResults((prev) =>
              prev.map((res) => {
                if (res.line === row.line) {
                  return {
                    ...res,
                    status: out.status,
                    details: out.details,
                    newAccessKey: out.newAK,
                    newSecretKey: out.newSK,
                  };
                }
                return res;
              })
            );
          } catch (e) {
            setResults((prev) =>
              prev.map((res) => {
                if (res.line === row.line) {
                  return {
                    ...res,
                    status: 'failed',
                    details: (e as Error).message || '未知错误',
                  };
                }
                return res;
              })
            );
          }
        })
      );

      setProgress((prev) => ({ done: Math.min((prev?.done ?? 0) + BATCH_SIZE, total), total }));
    }
  }

  // 1. Batch Verify
  async function handleVerify() {
    if (rows.length === 0) {
      toast.warning('请先粘贴有效的密钥对');
      return;
    }
    setRunning(true);
    setCurrentOp('verify');
    setActiveTab('progress');

    await runBatch(rows, async (row) => {
      try {
        const v = await api.verify({ accessKey: row.accessKey, secretKey: row.secretKey });
        return {
          status: 'ok',
          details: `有效 (${v.account_id}${v.is_root ? ' / Root' : ''})`,
        };
      } catch (e) {
        return {
          status: 'failed',
          details: (e as Error).message || '验证失败',
        };
      }
    });

    setRunning(false);
    setActiveTab('export');
    toast.success('批量验证完成');
  }

  // 2. Batch Rotate
  async function handleRotate() {
    if (rows.length === 0) {
      toast.warning('请先粘贴有效的密钥对');
      return;
    }
    setRunning(true);
    setCurrentOp('rotate');
    setActiveTab('progress');

    await runBatch(rows, async (row) => {
      try {
        const r = await api.rotateFull({ accessKey: row.accessKey, secretKey: row.secretKey });
        if (r.verified && r.old_deleted) {
          return {
            status: 'ok',
            details: `轮换成功`,
            newAK: r.new_access_key,
            newSK: r.new_secret_key,
          };
        } else if (r.verified) {
          return {
            status: 'ok',
            details: `轮换成功 (但旧密钥删除失败)`,
            newAK: r.new_access_key,
            newSK: r.new_secret_key,
          };
        } else {
          return {
            status: 'failed',
            details: `轮换失败: 新密钥未能生效`,
          };
        }
      } catch (e) {
        return {
          status: 'failed',
          details: (e as Error).message || '轮换失败',
        };
      }
    });

    setRunning(false);
    setActiveTab('export');
    toast.success('批量轮换完成');
  }

  // 3. Batch Quota
  async function handleQuota() {
    if (rows.length === 0) {
      toast.warning('请先粘贴有效的密钥对');
      return;
    }
    setRunning(true);
    setCurrentOp('quota');
    setActiveTab('progress');

    await runBatch(rows, async (row) => {
      try {
        const q = await api.quotaRegion({ accessKey: row.accessKey, secretKey: row.secretKey }, 'us-east-1');
        return {
          status: 'ok',
          details: `${q.value != null ? q.value + ' vCPUs' : '无限制'}`,
        };
      } catch (e) {
        return {
          status: 'failed',
          details: (e as Error).message || '查询失败',
        };
      }
    });

    setRunning(false);
    setActiveTab('export');
    toast.success('批量配额查询完成');
  }

  // Generate exported results text
  const exportText = useMemo(() => {
    if (results.length === 0 || running) return '';

    return results
      .map((res) => {
        if (currentOp === 'rotate') {
          if (res.status === 'ok' && res.newAccessKey && res.newSecretKey) {
            return res.originalText
              .replace(res.accessKey, res.newAccessKey)
              .replace(res.secretKey, res.newSecretKey);
          }
          return res.originalText;
        }

        if (currentOp === 'verify') {
          const prefix = res.remark ? `${res.remark} | ` : '';
          return `${prefix}${res.accessKey} | ${res.secretKey} | ${res.status === 'ok' ? '有效' : '无效'} | ${res.details}`;
        }

        if (currentOp === 'quota') {
          const prefix = res.remark ? `${res.remark} | ` : '';
          return `${prefix}${res.accessKey} | ${res.secretKey} | ${res.status === 'ok' ? res.details : '查询失败: ' + res.details}`;
        }

        return res.originalText;
      })
      .join('\n');
  }, [results, currentOp, running]);

  // Copy to clipboard
  async function handleCopy() {
    if (!exportText) return;
    try {
      await navigator.clipboard.writeText(exportText);
      toast.success('结果已复制到剪贴板');
    } catch {
      toast.error('复制失败，请手动选中文本复制');
    }
  }

  // Download as file
  function handleDownload() {
    if (!exportText) return;
    const blob = new Blob([exportText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `aws_keys_${currentOp || 'output'}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('文件下载成功');
  }

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-7xl px-6 py-6">
        {/* ---------- Top bar ---------- */}
        <div className="mb-5 flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="!size-8 !p-0"
            onClick={() => navigate('/')}
            aria-label="返回"
            title="返回账号列表"
          >
            <ArrowLeft size={16} />
          </Button>
          <div className="flex items-center gap-2">
            <KeyRound className="text-[var(--color-primary-main)]" size={18} />
            <h1 className="text-lg font-semibold tracking-tight">密钥工具箱</h1>
          </div>
          <span className="text-xs text-[var(--color-fg-muted)] flex-1">
            独立的批量密钥校验、轮换和额度查询工具，无需添加到系统存储
          </span>
        </div>

        {/* ---------- Main Content Grid ---------- */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Left panel: textarea input */}
          <div className="space-y-4 lg:col-span-5">
            <section className="glass-panel p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-secondary)] flex items-center gap-1.5">
                  <FileText size={14} /> 密钥输入区
                </span>
                {rows.length > 0 && (
                  <span className="text-xs text-green-500 font-medium animate-in fade-in">
                    已识别 {rows.length} 对密钥
                  </span>
                )}
                {invalidLines.length > 0 && (
                  <span className="text-xs text-amber-500 font-medium animate-in fade-in" title={`第 ${invalidLines.join(', ')} 行格式无法识别`}>
                    格式未识别 {invalidLines.length} 行
                  </span>
                )}
              </div>

              <div className="relative group">
                <div className="absolute -inset-0.5 rounded-xl bg-gradient-to-br from-[var(--color-primary-main)] to-purple-500 opacity-[0.1] group-focus-within:opacity-25 transition-opacity duration-300"></div>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  disabled={running}
                  className="relative glass-input block h-[380px] w-full resize-y rounded-xl px-4 py-3 font-mono text-xs leading-relaxed text-[var(--color-fg-primary)] outline-none placeholder-[var(--color-fg-muted)]/50 focus:ring-1 focus:ring-[var(--color-primary-main)]/40"
                  placeholder={`# 支持批量智能解析，顺序或分隔符不限
# 备注(可选)   AccessKey   SecretKey
# 例如：
小号A  AKIAIOSFODNN7EXAMPLE  wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>

              {/* Action Buttons */}
              <div className="mt-4 flex flex-wrap gap-2.5">
                <Button
                  onClick={handleVerify}
                  disabled={running || rows.length === 0}
                  variant="primary"
                  size="sm"
                  className="flex-1 min-w-[100px]"
                >
                  {running && currentOp === 'verify' ? (
                    <>
                      <Loader2 size={13} className="animate-spin mr-1.5" />
                      验证中...
                    </>
                  ) : (
                    '批量验证'
                  )}
                </Button>
                <Button
                  onClick={handleRotate}
                  disabled={running || rows.length === 0}
                  variant="primary"
                  size="sm"
                  className="flex-1 min-w-[100px] !bg-gradient-to-r !from-indigo-600 !to-purple-600 hover:brightness-110"
                >
                  {running && currentOp === 'rotate' ? (
                    <>
                      <Loader2 size={13} className="animate-spin mr-1.5" />
                      轮换中...
                    </>
                  ) : (
                    '批量轮换'
                  )}
                </Button>
                <Button
                  onClick={handleQuota}
                  disabled={running || rows.length === 0}
                  variant="outline"
                  size="sm"
                  className="flex-1 min-w-[100px]"
                >
                  {running && currentOp === 'quota' ? (
                    <>
                      <Loader2 size={13} className="animate-spin mr-1.5" />
                      查询中...
                    </>
                  ) : (
                    '查配额(美东)'
                  )}
                </Button>
              </div>
            </section>
          </div>

          {/* Right panel: results list/table & export */}
          <div className="space-y-4 lg:col-span-7">
            <section className="glass-panel p-4 flex flex-col h-[calc(100vh-140px)] min-h-[500px]">
              {/* Tab Header */}
              <div className="mb-3 flex items-center justify-between border-b border-white/5 pb-2">
                <div className="flex gap-4">
                  <button
                    type="button"
                    onClick={() => setActiveTab('progress')}
                    className={clsx(
                      'pb-2 text-sm font-semibold border-b-2 transition-all',
                      activeTab === 'progress'
                        ? 'border-[var(--color-primary-main)] text-[var(--color-fg-primary)]'
                        : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]'
                    )}
                  >
                    执行进度
                  </button>
                  {exportText && (
                    <button
                      type="button"
                      onClick={() => setActiveTab('export')}
                      className={clsx(
                        'pb-2 text-sm font-semibold border-b-2 transition-all flex items-center gap-1.5',
                        activeTab === 'export'
                          ? 'border-[var(--color-primary-main)] text-[var(--color-fg-primary)]'
                          : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]'
                      )}
                    >
                      <Sparkles size={13} className="text-amber-400" />
                      导出结果
                    </button>
                  )}
                </div>

                {activeTab === 'progress' && running && progress && (
                  <span className="text-xs text-[var(--color-primary-main)] font-mono">
                    已完成: {progress.done} / {progress.total}
                  </span>
                )}

                {activeTab === 'export' && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleCopy}
                      className="text-xs text-[var(--color-primary-main)] hover:underline flex items-center gap-1"
                    >
                      <Copy size={11} /> 复制结果
                    </button>
                    <button
                      onClick={handleDownload}
                      className="text-xs text-[var(--color-primary-main)] hover:underline flex items-center gap-1"
                    >
                      <FileDown size={11} /> 下载 txt
                    </button>
                  </div>
                )}
              </div>

              {/* Progress bar */}
              {activeTab === 'progress' && running && progress && (
                <div className="mb-4 h-1.5 w-full rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-[var(--color-primary-main)] to-purple-500 transition-all duration-300"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }}
                  />
                </div>
              )}

              {/* Tab Content */}
              {activeTab === 'progress' ? (
                results.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-fg-muted)] space-y-2">
                    <KeyRound size={32} className="opacity-20" />
                    <p className="text-sm">暂无数据，请在左侧输入密钥并开始执行任务</p>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto pr-1">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-white/5 text-xs text-[var(--color-fg-muted)] font-medium">
                          <th className="py-2 w-10">行</th>
                          <th className="py-2 pl-2">备注</th>
                          <th className="py-2 pl-2">Access Key</th>
                          <th className="py-2 pl-2 w-20">状态</th>
                          <th className="py-2 pl-2">执行结果</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.02]">
                        {results.map((res) => (
                          <tr key={res.line} className="text-xs hover:bg-white/[0.01]">
                            <td className="py-2.5 font-mono text-[var(--color-fg-muted)]">{res.line}</td>
                            <td className="py-2.5 pl-2 truncate max-w-[100px] font-medium" title={res.remark}>
                              {res.remark || '—'}
                            </td>
                            <td className="py-2.5 pl-2 font-mono" title={res.accessKey}>
                              {res.accessKey.slice(0, 8)}...
                            </td>
                            <td className="py-2.5 pl-2">
                              {res.status === 'idle' && (
                                <span className="text-[var(--color-fg-muted)]">等待</span>
                              )}
                              {res.status === 'pending' && (
                                <span className="text-blue-400 flex items-center gap-1">
                                  <Loader2 size={11} className="animate-spin" /> 执行
                                </span>
                              )}
                              {res.status === 'ok' && (
                                <span className="text-green-500 flex items-center gap-1">
                                  <CheckCircle2 size={11} /> 成功
                                </span>
                              )}
                              {res.status === 'failed' && (
                                <span className="text-[var(--color-status-error)] flex items-center gap-1">
                                  <XCircle size={11} /> 失败
                                </span>
                              )}
                            </td>
                            <td
                              className={clsx(
                                'py-2.5 pl-2 truncate max-w-[200px]',
                                res.status === 'ok'
                                  ? 'text-green-400 font-medium'
                                  : res.status === 'failed'
                                    ? 'text-[var(--color-status-error)] font-medium'
                                    : 'text-[var(--color-fg-muted)]'
                              )}
                              title={res.details}
                            >
                              {res.status === 'ok' && res.newAccessKey ? (
                                <span className="font-mono">
                                  新: {res.newAccessKey.slice(0, 8)}...
                                </span>
                              ) : (
                                res.details || '—'
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : (
                <div className="flex-1 flex flex-col h-full">
                  <textarea
                    readOnly
                    value={exportText}
                    className="flex-1 w-full rounded-xl px-4 py-3 font-mono text-xs leading-relaxed text-[var(--color-fg-primary)] outline-none bg-white/[0.01] border border-white/5 resize-none focus:ring-1 focus:ring-[var(--color-primary-main)]/40"
                    placeholder="导出结果为空"
                  />
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
