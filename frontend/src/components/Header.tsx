/**
 * App header / toolbar — visible after the vault is unlocked.
 * Aligned to the same max-w-7xl container as the card grid.
 *
 * Toolbar layout (per design):
 *   添加 · 批量添加 · 删除 · vCPUs(刷新所有配额) · 搜索(回车提交) · 分组
 *   ... theme toggle · lock (utility actions tucked to the far right)
 *
 * "删除" is always visible but disabled when nothing is selected, so its
 * position never moves. To deselect, the user clicks the card checkbox
 * again — no separate "cancel selection" button by design.
 *
 * Search uses Enter-to-commit semantics: typing only updates a local draft;
 * filtering applies only when the user presses Enter (or clicks the X).
 */

import { useEffect, useState } from 'react';
import {
  Lock,
  Plus,
  Sun,
  Moon,
  Search,
  Trash2,
  Upload,
  Download,
  ArchiveRestore,
  Zap,
  FolderTree,
  Server,
  KeyRound,
  X,
  Building2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from './ui/Button';
import { Logo } from './ui/Logo';
import { lockVault } from '@/lib/vault';
import { useTheme } from '@/hooks/useTheme';

interface Props {
  accountCount: number;
  selectedCount: number;
  bulkDeleting: boolean;
  exporting: boolean;
  importing: boolean;
  refreshingQuotas: boolean;

  onAdd: () => void;
  onBulkAdd: () => void;
  onBulkDelete: () => void;
  onExport: () => void;
  onImport: () => void;
  onRefreshAllQuotas: () => void;
  onOpenGroups: () => void;
  /** Currently-committed search query (empty string = no filter). */
  search: string;
  onSearchCommit: (v: string) => void;
}

export function Header({
  accountCount,
  selectedCount,
  bulkDeleting,
  exporting,
  importing,
  refreshingQuotas,

  onAdd,
  onBulkAdd,
  onBulkDelete,
  onExport,
  onImport,
  onRefreshAllQuotas,
  onOpenGroups,
  search,
  onSearchCommit,
}: Props) {
  const { theme, toggle } = useTheme();
  const hasSelection = selectedCount > 0;
  const navigate = useNavigate();

  // Local "draft" — what's typed but not yet committed. Stays in sync with
  // any external clear (e.g. user wipes the query via state).
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);

  return (
    <header className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-6">
      <div className="flex min-w-0 items-center gap-3">
        <Logo size={36} className="shrink-0 rounded-xl shadow-[0_4px_16px_-6px_oklch(0.55_0.18_260/0.7)]" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">AWS管理助手</h1>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
            <span>
              {hasSelection ? (
                <>
                  已选{' '}
                  <span className="font-mono text-[var(--color-fg-primary)]">{selectedCount}</span>{' '}
                  / {accountCount} 个
                </>
              ) : (
                <>{accountCount} 个账号</>
              )}
            </span>

          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Button onClick={onAdd} leadingIcon={<Plus size={15} />} size="sm">
          添加
        </Button>
        <Button onClick={onBulkAdd} leadingIcon={<Upload size={14} />} size="sm" variant="ghost">
          批量添加
        </Button>
        <Button
          onClick={onBulkDelete}
          leadingIcon={<Trash2 size={14} />}
          size="sm"
          variant={hasSelection ? 'danger' : 'ghost'}
          disabled={!hasSelection}
          loading={bulkDeleting}
        >
          删除
        </Button>
        {hasSelection ? (
          <Button
            onClick={onExport}
            leadingIcon={<Download size={14} />}
            size="sm"
            variant="ghost"
            loading={exporting}
            title="导出选中账号为 JSON 备份(含明文 AK/SK,请妥善保管)"
          >
            导出
          </Button>
        ) : (
          <Button
            onClick={onImport}
            leadingIcon={<ArchiveRestore size={14} />}
            size="sm"
            variant="ghost"
            loading={importing}
            title="从备份 JSON 文件恢复账号(备份与恢复)"
          >
            导入
          </Button>
        )}
        <Button
          onClick={onRefreshAllQuotas}
          leadingIcon={<Zap size={14} />}
          size="sm"
          variant="ghost"
          loading={refreshingQuotas}
          title="一键刷新所有账号默认区域 vCPU 配额"
        >
          vCPUs
        </Button>

        {/* Search — Enter to commit, X to clear */}
        <form
          className="glass-input hidden h-9 items-center gap-1.5 px-2.5 sm:flex"
          onSubmit={(e) => {
            e.preventDefault();
            onSearchCommit(draft.trim());
          }}
        >
          <Search size={14} className="text-[var(--color-fg-muted)]" />
          <input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="搜索账号"
            className="w-24 bg-transparent text-sm outline-none placeholder:text-[var(--color-fg-muted)] lg:w-32"
          />
          {search && (
            <button
              type="button"
              onClick={() => {
                setDraft('');
                onSearchCommit('');
              }}
              className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
              aria-label="清除搜索"
            >
              <X size={14} />
            </button>
          )}
        </form>

        <Button
          onClick={onOpenGroups}
          leadingIcon={<FolderTree size={14} />}
          size="sm"
          variant="ghost"
        >
          分组
        </Button>

        <Button
          onClick={() => navigate('/lambda')}
          leadingIcon={<Server size={14} />}
          size="sm"
          variant="ghost"
          title="多账号 / 多区域部署后端 Lambda 节点(IP 多样性)"
        >
          Lambda
        </Button>

        <Button
          onClick={() => navigate('/key-tools')}
          leadingIcon={<KeyRound size={14} />}
          size="sm"
          variant="ghost"
          title="独立的批量密钥校验、轮换和额度查询工具"
        >
          密钥工具
        </Button>

        <Button
          onClick={() => navigate('/org')}
          leadingIcon={<Building2 size={14} />}
          size="sm"
          variant="ghost"
          title="AWS 组织与子账号批量开户与密钥生成管理"
        >
          组织管理
        </Button>

        <span className="mx-1 h-5 w-px bg-[var(--color-border-glass)]" aria-hidden />

        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          title={theme === 'dark' ? '切换到浅色(方便截图)' : '切换到深色'}
          className="!size-8 !p-0"
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </Button>
        <Button variant="ghost" onClick={lockVault} leadingIcon={<Lock size={14} />} size="sm">
          退出
        </Button>
      </div>
    </header>
  );
}
