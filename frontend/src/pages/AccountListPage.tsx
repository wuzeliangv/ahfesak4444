/**
 * The dashboard — responsive grid of account cards (1 / 2 / 3 columns) plus
 * the toolbar in Header.
 *
 * Toolbar wiring:
 *   - 添加 / 批量添加 / 分组 → open the corresponding modal
 *   - 删除                 → bulk-delete currently selected cards
 *   - vCPUs               → refresh every card's default-region quota in parallel
 *   - 搜索                 → commits on Enter; filters by alias only
 *
 * Selection is purely visual on each card (no separate bulk bar that
 * pushes the grid). Clicking the card's checkbox toggles selection.
 */

import { useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Inbox } from 'lucide-react';
import { listAccounts, deleteAccount, getAccountCredentials, importAccounts } from '@/lib/vault';
import { type AccountRecord } from '@/lib/db';
import { downloadText, todayStamp } from '@/lib/csv';
import { Header } from '@/components/Header';
import { AccountCard } from '@/components/AccountCard';
import { AccountFormModal } from '@/components/AccountFormModal';
import { BulkAddModal } from '@/components/BulkAddModal';
import { GroupModal } from '@/components/GroupModal';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';

export function AccountListPage() {
  const qc = useQueryClient();
  const accountsQ = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
  });

  const [editing, setEditing] = useState<AccountRecord | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [bulkAdding, setBulkAdding] = useState(false);
  const [managingGroups, setManagingGroups] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [refreshingQuotas, setRefreshingQuotas] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const removeMu = useMutation({
    mutationFn: deleteAccount,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const bulkDeleteMu = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await deleteAccount(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      setSelected(new Set());
    },
  });

  const accounts = accountsQ.data ?? [];

  // Search filter — alias-only by user spec, applied after Enter commit.
  const q = query.trim().toLowerCase();
  const visible = q ? accounts.filter((a) => a.alias.toLowerCase().includes(q)) : accounts;

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }



  async function refreshAllQuotas() {
    setRefreshingQuotas(true);
    try {
      // Invalidate every per-card "quota-headline" query — TanStack Query
      // refetches them in parallel and waits for completion.
      await qc.invalidateQueries({ queryKey: ['quota-headline'] });
      await qc.refetchQueries({ queryKey: ['quota-headline'] });
    } finally {
      setRefreshingQuotas(false);
    }
  }

  async function exportSelected() {
    if (selected.size === 0) return;
    setExporting(true);
    try {
      const byId = new Map(accounts.map((a) => [a.id, a] as const));
      const items: Array<Record<string, unknown>> = [];
      for (const id of selected) {
        const acc = byId.get(id);
        if (!acc) continue;
        const creds = await getAccountCredentials(id);
        items.push({
          alias: acc.alias,
          accessKey: creds.accessKey,
          secretKey: creds.secretKey,
          defaultRegion: acc.defaultRegion,
          group: acc.group ?? null,
          note: acc.note ?? null,
          color: acc.color ?? null,
          pinnedRegion: acc.pinnedRegion ?? null,
          monitorVcpu: !!acc.monitorVcpu,
          verified: acc.verified ?? null,
          quota: acc.quota ?? null,
        });
      }
      const backup = {
        type: 'aws-panel-accounts-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        count: items.length,
        accounts: items,
      };
      downloadText(
        `aws-panel-backup-${todayStamp()}-${items.length}.json`,
        JSON.stringify(backup, null, 2),
        'application/json;charset=utf-8',
        false, // JSON must not carry a BOM (would break JSON.parse on import)
      );
      toast.success(`已导出 ${items.length} 个账号`, { title: '导出完成' });
    } catch (e) {
      toast.error((e as Error).message, { title: '导出失败' });
    } finally {
      setExporting(false);
    }
  }

  function triggerImport() {
    fileInputRef.current?.click();
  }

  async function handleImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    setImporting(true);
    try {
      const raw = await file.text();
      const text = raw.replace(/^\uFEFF/, ''); // tolerate a stray BOM
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('无法解析备份文件(需要导出的 JSON 文件)');
      }
      const items = extractBackupAccounts(parsed);
      if (items.length === 0) throw new Error('备份文件里没有可恢复的账号');
      const { imported, skipped } = await importAccounts(items);
      await qc.invalidateQueries({ queryKey: ['accounts'] });
      if (imported > 0) {
        toast.success(
          `已恢复 ${imported} 个账号${skipped ? `,跳过 ${skipped} 个` : ''}`,
          { title: '导入完成' },
        );
      } else {
        toast.error(`没有导入任何账号(跳过 ${skipped} 个,格式可能不符)`, {
          title: '导入失败',
        });
      }
    } catch (err) {
      toast.error((err as Error).message, { title: '导入失败' });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="min-h-screen">
      <Header
        accountCount={accounts.length}
        selectedCount={selected.size}
        bulkDeleting={bulkDeleteMu.isPending}
        exporting={exporting}
        importing={importing}
        refreshingQuotas={refreshingQuotas}

        onAdd={() => setAdding(true)}
        onBulkAdd={() => setBulkAdding(true)}
        onBulkDelete={() => {
          if (selected.size === 0) return;
          bulkDeleteMu.mutate([...selected]);
        }}
        onExport={exportSelected}
        onImport={triggerImport}
        onRefreshAllQuotas={refreshAllQuotas}
        onOpenGroups={() => setManagingGroups(true)}
        search={query}
        onSearchCommit={setQuery}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFile}
      />

      <main className="mx-auto max-w-7xl px-6 pb-12">
        {accountsQ.isLoading ? (
          <SkeletonGrid />
        ) : accounts.length === 0 ? (
          <EmptyState onAdd={() => setAdding(true)} />
        ) : visible.length === 0 ? (
          <p className="mt-16 text-center text-sm text-[var(--color-fg-muted)]">
            没有匹配「{query}」的账号
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {visible.map((acc, i) => (
              <li key={acc.id}>
                <AccountCard
                  account={acc}
                  index={i + 1}
                  selected={selected.has(acc.id)}
                  onToggleSelect={() => toggleSelect(acc.id)}
                  onEdit={() => setEditing(acc)}
                  onDelete={() => removeMu.mutate(acc.id)}
                  onOpenEc2={() =>
                    window.open(`/account/${acc.id}/ec2`, '_blank', 'noopener,noreferrer')
                  }
                  onOpenLightsail={() =>
                    window.open(
                      `/account/${acc.id}/lightsail`,
                      '_blank',
                      'noopener,noreferrer',
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      <AccountFormModal open={adding} onClose={() => setAdding(false)} />
      <AccountFormModal
        open={!!editing}
        account={editing}
        onClose={() => setEditing(undefined)}
      />
      <BulkAddModal open={bulkAdding} onClose={() => setBulkAdding(false)} />
      <GroupModal open={managingGroups} onClose={() => setManagingGroups(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Pull a list of importable account objects out of a parsed backup file.
 * Accepts the export shape ({ type, accounts: [...] }), a bare { accounts }
 * object, or a bare array. Only rows with AK/SK/region survive — the daemon
 * re-validates and skips the rest.
 */
function extractBackupAccounts(parsed: unknown): Array<Record<string, unknown>> {
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { accounts?: unknown }).accounts)) {
    arr = (parsed as { accounts: unknown[] }).accounts;
  } else {
    return [];
  }
  return (arr as unknown[]).filter(
    (x): x is Record<string, unknown> =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as Record<string, unknown>).accessKey === 'string' &&
      typeof (x as Record<string, unknown>).secretKey === 'string' &&
      typeof (x as Record<string, unknown>).defaultRegion === 'string',
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="glass-card mx-auto mt-16 flex max-w-md flex-col items-center p-10 text-center">
      <div className="mb-4 grid place-items-center size-12 rounded-2xl bg-[var(--color-accent-500)]/15 text-[var(--color-accent-300)]">
        <Inbox size={22} />
      </div>
      <h2 className="text-lg font-semibold">还没有账号</h2>
      <p className="mt-1 text-sm text-[var(--color-fg-secondary)]">
        添加第一个 AWS 账号,凭证会通过 AWS 校验后加密保存到服务端。
      </p>
      <Button onClick={onAdd} leadingIcon={<Plus size={16} />} className="mt-5">
        添加账号
      </Button>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="h-[150px] animate-pulse rounded-[var(--radius-card)] border border-[var(--color-border-glass)] bg-[var(--color-bg-elev)]"
          style={{ opacity: 1 - i * 0.12 }}
        />
      ))}
    </ul>
  );
}
