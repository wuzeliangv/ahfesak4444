import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Building2,
  UserPlus,
  Key,
  CheckCircle2,
  XCircle,
  Loader2,
  Sparkles,
  Users,
  Copy,
  FileDown,
  Plus,
  Trash2,
  Database,
  Search,
} from 'lucide-react';
import clsx from 'clsx';
import { Button } from '@/components/ui/Button';
import { api } from '@/lib/api';
import type { OrgAccountData } from '@/lib/api';
import { toast } from '@/lib/toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { listAccounts, getAccountCredentials, updateAccount } from '@/lib/vault';


interface CreateTask {
  name: string;
  email: string;
  status: 'idle' | 'pending' | 'ok' | 'failed';
  requestId?: string;
  accountId?: string;
  failureReason?: string;
  adminKeys?: {
    access_key: string;
    secret_key: string;
    user_name: string;
  };
}

export function OrganizationsPage() {
  usePageTitle('组织与子账号');
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Load imported account IDs for the Org page from localStorage
  const [importedIds, setImportedIds] = useState<string[]>(() => {
    try {
      const val = localStorage.getItem('org_imported_account_ids');
      return val ? JSON.parse(val) : [];
    } catch {
      return [];
    }
  });

  // Save to localStorage when changed
  useEffect(() => {
    localStorage.setItem('org_imported_account_ids', JSON.stringify(importedIds));
  }, [importedIds]);

  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [convertingRoot, setConvertingRoot] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);
  const [orgInfo, setOrgInfo] = useState<any>(null);
  const [subAccounts, setSubAccounts] = useState<OrgAccountData[]>([]);
  const [activeTab, setActiveTab] = useState<'members' | 'batch-create'>('members');

  // Import modal states
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [selectedImportIds, setSelectedImportIds] = useState<Set<string>>(new Set());

  // Batch create inputs & tasks
  const [inputText, setInputText] = useState('');
  const [creating, setCreating] = useState(false);
  const [createTasks, setCreateTasks] = useState<CreateTask[]>([]);
  const [createProgress, setCreateProgress] = useState<{ done: number; total: number } | null>(null);

  // Key generation states
  const [generatingKeyId, setGeneratingKeyId] = useState<string | null>(null);
  const [exportedKeysText, setExportedKeysText] = useState('');
  const [showExportModal, setShowExportModal] = useState(false);

  // Load all regular vault accounts from DB
  const { data: allAccounts = [], isLoading: loadingAccounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
  });

  // Filter accounts that are imported to the Org page
  const importedAccounts = useMemo(() => {
    return allAccounts.filter((a) => importedIds.includes(a.id));
  }, [allAccounts, importedIds]);

  // Keep dropdown selection valid
  useEffect(() => {
    if (importedAccounts.length > 0 && (!selectedAccountId || !importedIds.includes(selectedAccountId))) {
      setSelectedAccountId(importedAccounts[0].id);
    } else if (importedAccounts.length === 0) {
      setSelectedAccountId('');
    }
  }, [importedAccounts, selectedAccountId, importedIds]);

  // Reset queried status when account changes
  useEffect(() => {
    setOrgInfo(null);
    setSubAccounts([]);
    setHasQueried(false);
  }, [selectedAccountId]);

  // Fetch Organization Status & Member Accounts (Manual trigger)
  const fetchOrgDetails = async (accId: string) => {
    if (!accId) return;
    setLoadingStatus(true);
    setHasQueried(false);
    setOrgInfo(null);
    setSubAccounts([]);
    try {
      const creds = await getAccountCredentials(accId);
      const status = await api.orgStatus(creds);
      setOrgInfo(status);

      if (status.in_use && status.is_management) {
        const members = await api.orgAccountsList(creds);
        setSubAccounts(members.accounts);
      }
      setHasQueried(true);
      toast.success('组织状态查询完成');
    } catch (e) {
      toast.error((e as Error).message || '获取组织信息失败');
    } finally {
      setLoadingStatus(false);
    }
  };

  // Trigger converting Root keys to IAM admin user
  const handleConvertRootToIam = async () => {
    if (!selectedAccountId) return;
    setConvertingRoot(true);
    try {
      const creds = await getAccountCredentials(selectedAccountId);
      const res = await api.orgCreateMasterIam(creds);

      const account = allAccounts.find((a) => a.id === selectedAccountId);
      if (account) {
        await updateAccount(selectedAccountId, {
          accessKey: res.access_key,
          secretKey: res.secret_key,
          verified: account.verified
            ? {
                ...account.verified,
                akPrefix: res.access_key.slice(0, 8),
                isRoot: false,
              }
            : undefined,
        });
        qc.invalidateQueries({ queryKey: ['accounts'] });
        toast.success(`成功在主账号内生成并自动切换至 IAM 账号: ${res.user_name}`);

        // Re-query org details
        await fetchOrgDetails(selectedAccountId);
      }
    } catch (e) {
      toast.error((e as Error).message || '创建并切换 IAM 用户失败');
    } finally {
      setConvertingRoot(false);
    }
  };

  // Initializing Organization
  const handleCreateOrg = async () => {
    if (!selectedAccountId) return;
    try {
      setLoadingStatus(true);
      const creds = await getAccountCredentials(selectedAccountId);
      await api.orgCreate(creds);
      toast.success('组织启用成功！');
      fetchOrgDetails(selectedAccountId);
    } catch (e) {
      toast.error((e as Error).message || '初始化组织失败');
      setLoadingStatus(false);
    }
  };

  // Import selector actions
  const handleImportSelectToggle = (id: string) => {
    setSelectedImportIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirmImport = () => {
    if (selectedImportIds.size === 0) {
      setIsImportModalOpen(false);
      return;
    }
    const newIds = Array.from(selectedImportIds);
    setImportedIds((prev) => Array.from(new Set([...prev, ...newIds])));
    setSelectedImportIds(new Set());
    setIsImportModalOpen(false);
    toast.success('成功导入管理账号列表！');
  };

  const handleRemoveImport = () => {
    if (!selectedAccountId) return;
    setImportedIds((prev) => prev.filter((id) => id !== selectedAccountId));
    toast.success('已将该账号从本页列表移除');
  };

  // Parsing pasted accounts
  const parsedInputs = useMemo(() => {
    const lines = inputText.split(/\r?\n/);
    const valid: { name: string; email: string }[] = [];
    for (const l of lines) {
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Splits by | or comma
      const parts = trimmed.split(/[|,]+/);
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const email = parts[1].trim();
        if (name && email.includes('@')) {
          valid.push({ name, email });
        }
      }
    }
    return valid;
  }, [inputText]);

  // Asynchronous creation status checker
  const pollAccountCreation = async (accId: string, requestId: string): Promise<string> => {
    const creds = await getAccountCredentials(accId);
    for (let attempts = 0; attempts < 60; attempts++) { // max 5 minutes (5s delay)
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        const status = await api.orgAccountsStatus(creds, requestId);
        if (status.state === 'SUCCEEDED' && status.account_id) {
          return status.account_id;
        }
        if (status.state === 'FAILED') {
          throw new Error(status.failure_reason || 'AWS 创建账号失败');
        }
      } catch (e) {
        if ((e as Error).message.includes('AWS 创建账号失败')) {
          throw e;
        }
      }
    }
    throw new Error('创建子账号超时，请稍后手动刷新');
  };

  // Triggering batch creation
  const handleBatchCreate = async () => {
    if (parsedInputs.length === 0 || !selectedAccountId) {
      toast.warning('请先输入有效的子账号名称与邮箱');
      return;
    }

    setCreating(true);
    const total = parsedInputs.length;
    setCreateProgress({ done: 0, total });
    
    // Initialize tasks
    const tasks: CreateTask[] = parsedInputs.map((p) => ({
      name: p.name,
      email: p.email,
      status: 'idle',
    }));
    setCreateTasks(tasks);

    const creds = await getAccountCredentials(selectedAccountId);

    for (let i = 0; i < total; i++) {
      const task = tasks[i];
      
      setCreateTasks((prev) =>
        prev.map((t, idx) => (idx === i ? { ...t, status: 'pending' } : t))
      );

      try {
        const req = await api.orgAccountsCreate(creds, { email: task.email, name: task.name });
        
        setCreateTasks((prev) =>
          prev.map((t, idx) =>
            idx === i ? { ...t, requestId: req.request_id } : t
          )
        );

        const newAccountId = await pollAccountCreation(selectedAccountId, req.request_id);

        setCreateTasks((prev) =>
          prev.map((t, idx) =>
            idx === i ? { ...t, status: 'ok', accountId: newAccountId } : t
          )
        );

      } catch (err) {
        setCreateTasks((prev) =>
          prev.map((t, idx) =>
            idx === i
              ? { ...t, status: 'failed', failureReason: (err as Error).message || '未知错误' }
              : t
          )
        );
      }

      setCreateProgress((prev) => ({ done: (prev?.done ?? 0) + 1, total }));
    }

    setCreating(false);
    fetchOrgDetails(selectedAccountId);
    toast.success('批量创建任务执行完毕');
  };

  // Generate Admin AK/SK manually
  const handleGenerateKeys = async (subAccountId: string, accountName: string) => {
    if (!selectedAccountId) return;
    setGeneratingKeyId(subAccountId);
    try {
      const creds = await getAccountCredentials(selectedAccountId);
      const keyData = await api.orgAccountsCreateKeys(creds, { subAccountId });
      
      const formatted = `${accountName} | ${keyData.access_key} | ${keyData.secret_key}`;
      setExportedKeysText(formatted);
      setShowExportModal(true);
      toast.success(`管理员密钥生成成功！`);
    } catch (e) {
      toast.error((e as Error).message || '生成密钥失败');
    } finally {
      setGeneratingKeyId(null);
    }
  };

  const exportAllCreatedKeys = useMemo(() => {
    return createTasks
      .filter((t) => t.status === 'ok' && t.adminKeys)
      .map((t) => `${t.name} | ${t.adminKeys!.access_key} | ${t.adminKeys!.secret_key}`)
      .join('\n');
  }, [createTasks]);

  const handleCopyKeys = (textVal: string) => {
    if (!textVal) return;
    navigator.clipboard.writeText(textVal)
      .then(() => toast.success('已复制到剪贴板'))
      .catch(() => toast.error('复制失败，请手动选择复制'));
  };

  const handleDownloadKeys = (textVal: string, fileName: string) => {
    if (!textVal) return;
    const blob = new Blob([textVal], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('文件下载成功');
  };

  // Find accounts in main vault not imported to this page
  const nonImportedAccounts = useMemo(() => {
    return allAccounts.filter((a) => !importedIds.includes(a.id));
  }, [allAccounts, importedIds]);

  return (
    <div className="min-h-screen">
      <main className="mx-auto max-w-7xl px-6 py-6">
        
        {/* ---------- Top Navigation & Header ---------- */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-white/5 pb-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              className="!size-8 !p-0"
              onClick={() => navigate('/')}
              aria-label="返回"
              title="返回首页"
            >
              <ArrowLeft size={16} />
            </Button>
            <div className="flex items-center gap-2">
              <Building2 className="text-[var(--color-primary-main)]" size={20} />
              <h1 className="text-xl font-bold tracking-tight">组织与子账号管理</h1>
            </div>
          </div>

          {/* Org Page Specific Account Selector */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-[var(--color-fg-muted)]">选择管理账号：</span>
            {loadingAccounts ? (
              <Loader2 size={14} className="animate-spin text-[var(--color-fg-muted)]" />
            ) : importedAccounts.length > 0 ? (
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                disabled={creating || loadingStatus}
                className="glass-input h-9 rounded-lg px-3 text-sm text-[var(--color-fg-primary)] bg-black/40 border border-white/10 outline-none focus:border-[var(--color-primary-main)]/40 focus:ring-1 focus:ring-[var(--color-primary-main)]/30"
              >
                {importedAccounts.map((a) => (
                  <option key={a.id} value={a.id} className="bg-[var(--color-bg-popover)]">
                    {a.alias} ({a.verified?.accountId?.slice(-4) || '未验证'})
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-amber-400 font-medium">请先导入主账号</span>
            )}

            {/* Actions for managing account list in Org Page */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsImportModalOpen(true)}
              className="flex items-center gap-1 hover:border-blue-500/40"
              title="导入账号卡片页的主账号至本页"
            >
              <Plus size={14} /> 导入账号
            </Button>

            {selectedAccountId && (
              <Button
                variant="danger"
                size="sm"
                onClick={handleRemoveImport}
                disabled={creating || loadingStatus}
                className="flex items-center gap-1"
                title="从此页下拉列表中移除该账号(不删除数据库账号)"
              >
                <Trash2 size={14} /> 移出本页
              </Button>
            )}
          </div>
        </div>

        {/* ---------- Main Content Grid ---------- */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:h-[calc(100vh-160px)] lg:min-h-[550px]">
          
          {/* LEFT: Org Info Panel (4 cols) */}
          <section className="glass-panel p-4 lg:col-span-4 flex flex-col h-full overflow-y-auto">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-secondary)] flex items-center gap-1.5 border-b border-white/5 pb-2">
              <Building2 size={14} /> 组织基础信息
            </h2>

            {selectedAccountId ? (
              <div className="space-y-4 flex flex-col flex-1">
                {/* LARGE MANUAL QUERY BUTTON */}
                <Button
                  variant="primary"
                  onClick={() => fetchOrgDetails(selectedAccountId)}
                  disabled={loadingStatus || creating}
                  className="w-full justify-center flex items-center gap-1.5 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:brightness-110 shadow-lg shadow-blue-500/10"
                >
                  {loadingStatus ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      正在获取组织数据...
                    </>
                  ) : (
                    <>
                      <Search size={14} />
                      查询组织状态
                    </>
                  )}
                </Button>

                {/* Info Container */}
                {loadingStatus ? (
                  <div className="flex-1 flex flex-col items-center justify-center space-y-2 py-12">
                    <Loader2 size={24} className="animate-spin text-blue-500" />
                    <span className="text-xs text-[var(--color-fg-muted)]">正在调用 AWS API...</span>
                  </div>
                ) : hasQueried && orgInfo ? (
                  <div className="space-y-4 flex-1">
                    {/* Status badge */}
                    <div className="rounded-xl bg-white/[0.02] border border-white/5 p-3.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[var(--color-fg-muted)]">组织状态</span>
                        <span
                          className={clsx(
                            'text-xs px-2.5 py-0.5 rounded-full font-medium',
                            orgInfo.in_use
                              ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                              : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                          )}
                        >
                          {orgInfo.in_use ? '已启用组织' : '未启用组织'}
                        </span>
                      </div>
                      {orgInfo.in_use && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-[var(--color-fg-muted)]">角色权限</span>
                          <span
                            className={clsx(
                              'text-xs font-medium',
                              orgInfo.is_management ? 'text-indigo-400' : 'text-amber-400'
                            )}
                          >
                            {orgInfo.is_management ? '👑 管理账号 (Master)' : '成员账号 (Member)'}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Details Table */}
                    <div className="space-y-3">
                      <div className="flex flex-col border-b border-white/[0.03] pb-2">
                        <span className="text-[10px] text-[var(--color-fg-muted)] uppercase">当前账号 ID</span>
                        <span className="text-xs font-mono text-[var(--color-fg-primary)]">{orgInfo.caller_account_id}</span>
                      </div>
                      
                      {orgInfo.in_use && (
                        <>
                          <div className="flex flex-col border-b border-white/[0.03] pb-2">
                            <span className="text-[10px] text-[var(--color-fg-muted)] uppercase">组织 ID (Org ID)</span>
                            <span className="text-xs font-mono text-[var(--color-fg-primary)]">{orgInfo.organization_id}</span>
                          </div>
                          <div className="flex flex-col border-b border-white/[0.03] pb-2">
                            <span className="text-[10px] text-[var(--color-fg-muted)] uppercase">管理账号 ID</span>
                            <span className="text-xs font-mono text-[var(--color-fg-primary)]">{orgInfo.master_account_id}</span>
                          </div>
                          <div className="flex flex-col border-b border-white/[0.03] pb-2">
                            <span className="text-[10px] text-[var(--color-fg-muted)] uppercase">功能集 (Feature Set)</span>
                            <span className="text-xs text-[var(--color-fg-primary)]">{orgInfo.feature_set}</span>
                          </div>
                        </>
                      )}
                    </div>

                    {!orgInfo.in_use && (
                      <div className="mt-4 p-4 rounded-xl bg-amber-500/5 border border-amber-500/10 space-y-3">
                        <p className="text-xs text-amber-300 leading-relaxed">
                          当前 AWS 账号尚未激活 AWS Organizations 组织。您可以点击下方按钮一键启用，该账号将自动转为组织的“管理账号”。
                        </p>
                        <Button
                          variant="primary"
                          className="w-full flex justify-center items-center gap-1.5"
                          onClick={handleCreateOrg}
                        >
                          <Building2 size={14} /> 一键启用 AWS 组织
                        </Button>
                      </div>
                    )}

                    {orgInfo.is_root && (
                      <div className="mt-4 p-4 rounded-xl bg-red-500/5 border border-red-500/10 space-y-3">
                        <p className="text-xs text-red-300 leading-relaxed">
                          ⚠️ <b>检测到当前使用的是 Root 账号密钥。</b>由于 AWS 限制，Root 密钥无法扮演角色为子账号导出密钥。
                        </p>
                        <Button
                          variant="primary"
                          className="w-full flex justify-center items-center gap-1.5 bg-gradient-to-r from-amber-600 to-orange-600 hover:brightness-110 border border-amber-500/20"
                          onClick={handleConvertRootToIam}
                          loading={convertingRoot}
                        >
                          👑 一键创建并切换为 IAM 密钥
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-fg-muted)] text-xs text-center border border-dashed border-white/5 rounded-xl p-6 bg-white/[0.01]">
                    <Database size={24} className="mb-2 opacity-20 text-blue-400" />
                    <span>尚未获取组织基本数据</span>
                    <span className="text-[10px] opacity-70 mt-1">点击上方「查询组织状态」按钮进行获取</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-fg-muted)] text-xs text-center border border-dashed border-white/5 rounded-xl p-6">
                <span>请先点击右上角「导入账号」按钮</span>
                <span className="opacity-70 mt-1">并选择要管理的主账号。</span>
              </div>
            )}
          </section>

          {/* RIGHT: Member list & Batch Actions (8 cols) */}
          <section className="glass-panel p-4 lg:col-span-8 flex flex-col h-full min-h-0">
            {/* Tab Headers */}
            <div className="mb-4 flex items-center justify-between border-b border-white/5 pb-2">
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setActiveTab('members')}
                  className={clsx(
                    'pb-2 text-sm font-semibold border-b-2 transition-all',
                    activeTab === 'members'
                      ? 'border-[var(--color-primary-main)] text-[var(--color-fg-primary)]'
                      : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]'
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <Users size={14} /> 成员账号 ({hasQueried ? subAccounts.length : '?'})
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('batch-create')}
                  className={clsx(
                    'pb-2 text-sm font-semibold border-b-2 transition-all',
                    activeTab === 'batch-create'
                      ? 'border-[var(--color-primary-main)] text-[var(--color-fg-primary)]'
                      : 'border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]'
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <UserPlus size={14} /> 批量开子账号
                  </span>
                </button>
              </div>

              {activeTab === 'batch-create' && creating && createProgress && (
                <span className="text-xs text-[var(--color-primary-main)] font-mono animate-pulse">
                  进度: {createProgress.done} / {createProgress.total}
                </span>
              )}
            </div>

            {/* Content check: must query first */}
            {!hasQueried ? (
              <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-fg-muted)] space-y-2 py-20">
                <Building2 size={36} className="opacity-10 text-blue-500" />
                <p className="text-sm">请先在左边面板中点击「查询组织状态」按钮</p>
                <p className="text-xs opacity-60">以从 AWS 获取实时数据后进行管理操作</p>
              </div>
            ) : (
              <>
                {/* TAB CONTENT 1: MEMBER LIST */}
                {activeTab === 'members' && (
                  <div className="flex-1 overflow-y-auto pr-1 min-h-0">
                    {subAccounts.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-[var(--color-fg-muted)] space-y-2 py-20">
                        <Users size={36} className="opacity-10 text-[var(--color-primary-main)]" />
                        <p className="text-sm">该组织下尚未创建任何子账号</p>
                      </div>
                    ) : (
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-white/5 text-xs text-[var(--color-fg-muted)] font-medium">
                            <th className="py-2.5">子账号名称</th>
                            <th className="py-2.5 pl-2">账号 ID (AccountId)</th>
                            <th className="py-2.5 pl-2">绑定邮箱</th>
                            <th className="py-2.5 pl-2 w-20">状态</th>
                            <th className="py-2.5 pl-2 text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.02]">
                          {subAccounts.map((acc) => (
                            <tr key={acc.id} className="text-xs hover:bg-white/[0.01]">
                              <td className="py-3 font-semibold text-[var(--color-fg-primary)]">{acc.name}</td>
                              <td className="py-3 pl-2 font-mono">{acc.id}</td>
                              <td className="py-3 pl-2 truncate max-w-[150px]" title={acc.email}>
                                {acc.email}
                              </td>
                              <td className="py-3 pl-2">
                                <span
                                  className={clsx(
                                    'text-[10px] px-2 py-0.5 rounded font-medium border',
                                    acc.status === 'ACTIVE'
                                      ? 'bg-green-500/10 text-green-400 border-green-500/20'
                                      : 'bg-red-500/10 text-red-400 border-red-500/20'
                                  )}
                                >
                                  {acc.status}
                                </span>
                              </td>
                              <td className="py-3 pl-2 text-right">
                                <Button
                                  onClick={() => handleGenerateKeys(acc.id, acc.name)}
                                  disabled={generatingKeyId === acc.id}
                                  variant="outline"
                                  size="sm"
                                  className="text-xs flex items-center gap-1 inline-flex hover:!bg-[var(--color-primary-main)]/10"
                                >
                                  {generatingKeyId === acc.id ? (
                                    <Loader2 size={10} className="animate-spin" />
                                  ) : (
                                    <Key size={10} />
                                  )}
                                  生成/导出密钥
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {/* TAB CONTENT 2: BATCH CREATE */}
                {activeTab === 'batch-create' && (
                  <div className="flex-1 flex flex-col min-h-0 space-y-4">
                    {orgInfo && !orgInfo.is_management ? (
                      <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-red-500/5 border border-red-500/10 rounded-xl space-y-2">
                        <XCircle size={32} className="text-red-400" />
                        <p className="text-sm font-semibold text-red-300">当前账号权限不足</p>
                        <p className="text-xs text-[var(--color-fg-muted)] leading-relaxed max-w-md">
                          只有组织的“管理账号(Master Account)”才具有在组织内创建新成员账号的权限。当前选中的账号不是管理账号，无法启动批量开户。
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 flex-1 min-h-0">
                        {/* Input block */}
                        <div className="flex flex-col h-full min-h-[180px]">
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs text-[var(--color-fg-muted)]">输入格式：账号名称 | 邮箱</span>
                            {parsedInputs.length > 0 && (
                              <span className="text-xs text-indigo-400 font-semibold animate-pulse">
                                已识别 {parsedInputs.length} 个待创建子账号
                              </span>
                            )}
                          </div>
                          <div className="relative group flex-1 min-h-0">
                            <div className="absolute -inset-0.5 rounded-xl bg-gradient-to-br from-[var(--color-primary-main)] to-purple-500 opacity-[0.1] group-focus-within:opacity-25 transition-opacity duration-300"></div>
                            <textarea
                              value={inputText}
                              onChange={(e) => setInputText(e.target.value)}
                              disabled={creating}
                              className="relative glass-input block h-full w-full resize-none rounded-xl px-4 py-3 font-mono text-xs leading-relaxed text-[var(--color-fg-primary)] outline-none placeholder-[var(--color-fg-muted)]/50 focus:ring-1 focus:ring-[var(--color-primary-main)]/40 bg-white/[0.01]"
                              placeholder={`# 账号名称 | 绑定邮箱
# 支持邮箱别名快速开号 (例: mymail+aws01@outlook.com)
子账号1 | user+aws01@outlook.com
子账号2 | user+aws02@outlook.com`}
                              spellCheck={false}
                              autoComplete="off"
                            />
                          </div>

                          <div className="mt-3 flex gap-2">
                            <Button
                              variant="primary"
                              onClick={handleBatchCreate}
                              disabled={creating || parsedInputs.length === 0}
                              className="flex-1 justify-center py-2 flex items-center gap-1.5 bg-gradient-to-r from-[var(--color-primary-main)] to-purple-600 hover:brightness-110"
                            >
                              {creating ? (
                                <>
                                  <Loader2 size={14} className="animate-spin" />
                                  批量执行中 ({createProgress?.done}/{createProgress?.total})
                                </>
                              ) : (
                                <>
                                  <UserPlus size={14} />
                                  一键批量创建并开卡
                                </>
                              )}
                            </Button>
                          </div>
                        </div>

                        {/* Real-time Status block */}
                        <div className="glass-panel p-3 flex flex-col h-full overflow-y-auto border border-white/5 bg-white/[0.01] min-h-[180px]">
                          <div className="mb-2 flex items-center justify-between border-b border-white/5 pb-2">
                            <span className="text-xs font-semibold text-[var(--color-fg-muted)]">执行状态日志</span>
                            {exportAllCreatedKeys && !creating && (
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleCopyKeys(exportAllCreatedKeys)}
                                  className="text-[11px] text-[var(--color-primary-main)] hover:underline flex items-center gap-1"
                                >
                                  <Copy size={10} /> 复制全部密钥
                                </button>
                                <button
                                  onClick={() => handleDownloadKeys(exportAllCreatedKeys, 'created_sub_accounts_keys.txt')}
                                  className="text-[11px] text-[var(--color-primary-main)] hover:underline flex items-center gap-1"
                                >
                                  <FileDown size={10} /> 下载 txt
                                </button>
                              </div>
                            )}
                          </div>

                          {createTasks.length === 0 ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-[var(--color-fg-muted)] text-xs space-y-1 py-10">
                              <Sparkles size={20} className="opacity-20 text-[var(--color-primary-main)]" />
                              <span>等待启动批量创建任务</span>
                            </div>
                          ) : (
                            <div className="flex-1 min-h-0 overflow-y-auto">
                              <table className="w-full text-left border-collapse">
                                <thead>
                                  <tr className="border-b border-white/5 text-[10px] text-[var(--color-fg-muted)] font-medium">
                                    <th>名称</th>
                                    <th className="pl-1">状态</th>
                                    <th className="pl-1">AccountID / 说明</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {createTasks.map((t, idx) => (
                                    <tr key={idx} className="border-b border-white/[0.01] text-[11px] hover:bg-white/[0.01]">
                                      <td className="py-2 font-medium truncate max-w-[80px]" title={t.name}>{t.name}</td>
                                      <td className="py-2 pl-1 whitespace-nowrap">
                                        {t.status === 'idle' && (
                                          <span className="text-[var(--color-fg-muted)]">等待</span>
                                        )}
                                        {t.status === 'pending' && (
                                          <span className="text-blue-400 flex items-center gap-1">
                                            <Loader2 size={10} className="animate-spin" /> 进行中
                                          </span>
                                        )}
                                        {t.status === 'ok' && (
                                          <span className="text-green-500 flex items-center gap-1">
                                            <CheckCircle2 size={10} /> 成功
                                          </span>
                                        )}
                                        {t.status === 'failed' && (
                                          <span className="text-red-500 flex items-center gap-1">
                                            <XCircle size={10} /> 失败
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-2 pl-1 font-mono max-w-[120px] truncate" title={t.accountId || t.failureReason}>
                                        {t.status === 'ok' ? (
                                          <span className="text-green-400">
                                            {t.accountId} {t.adminKeys ? '(🔑 密钥已自动生成)' : '(🔑 密钥获取中)'}
                                          </span>
                                        ) : (
                                          <span className="text-red-400">{t.failureReason || '—'}</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

        </div>
      </main>

      {/* ---------- IMPORT ACCOUNT MODAL ---------- */}
      {isImportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="glass-panel w-full max-w-lg p-5 flex flex-col space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-white/5 pb-2">
              <span className="text-sm font-bold text-[var(--color-fg-primary)] flex items-center gap-1.5">
                <Database size={16} className="text-blue-400" />
                导入主账号
              </span>
              <button
                onClick={() => {
                  setSelectedImportIds(new Set());
                  setIsImportModalOpen(false);
                }}
                className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
              >
                ✕ 关闭
              </button>
            </div>

            <div className="text-xs text-[var(--color-fg-muted)] leading-relaxed">
              勾选您在主面板创建的 AWS 主账号，将其导入到此组织管理页面。仅在此页显示，不会修改或删除主面板的数据。
            </div>

            {nonImportedAccounts.length === 0 ? (
              <div className="py-8 text-center text-xs text-[var(--color-fg-muted)] border border-dashed border-white/5 rounded-xl">
                没有更多未导入的账号了
              </div>
            ) : (
              <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                {nonImportedAccounts.map((a) => (
                  <label
                    key={a.id}
                    className={clsx(
                      'flex items-center justify-between p-3 rounded-lg border border-white/5 bg-white/[0.01] hover:bg-white/[0.03] cursor-pointer transition-colors',
                      selectedImportIds.has(a.id) && 'border-blue-500/40 bg-blue-500/5'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedImportIds.has(a.id)}
                        onChange={() => handleImportSelectToggle(a.id)}
                        className="rounded border-white/10 bg-black/40 text-blue-500 focus:ring-0"
                      />
                      <div className="flex flex-col">
                        <span className="text-xs font-semibold text-[var(--color-fg-primary)]">{a.alias}</span>
                        <span className="text-[10px] text-[var(--color-fg-muted)] font-mono">{a.verified?.accountId || '未获取 AccountId'}</span>
                      </div>
                    </div>
                    {a.verified?.isRoot && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/10">Root</span>
                    )}
                  </label>
                ))}
              </div>
            )}

            <div className="flex gap-2 justify-end border-t border-white/5 pt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSelectedImportIds(new Set());
                  setIsImportModalOpen(false);
                }}
              >
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleConfirmImport}
                disabled={nonImportedAccounts.length === 0}
                className="bg-blue-600 hover:bg-blue-700"
              >
                确定导入
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- EXPORT MODAL ---------- */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="glass-panel w-full max-w-lg p-5 flex flex-col space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between border-b border-white/5 pb-2">
              <span className="text-xs font-semibold text-[var(--color-fg-secondary)] flex items-center gap-1.5">
                <Sparkles size={14} className="text-amber-400" />
                管理员密钥已生成
              </span>
              <button
                onClick={() => setShowExportModal(false)}
                className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg-primary)]"
              >
                ✕ 关闭
              </button>
            </div>

            <div className="text-xs text-[var(--color-fg-muted)] leading-relaxed">
              已在该子账号中成功创建管理员用户并生成密钥：
            </div>

            <textarea
              readOnly
              value={exportedKeysText}
              className="w-full h-24 rounded-xl px-4 py-3 font-mono text-xs leading-relaxed text-[var(--color-fg-primary)] outline-none bg-white/[0.01] border border-white/5 resize-none"
            />

            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleCopyKeys(exportedKeysText)}
                className="flex items-center gap-1"
              >
                <Copy size={13} />
                复制密钥
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleDownloadKeys(exportedKeysText, 'sub_account_keys.txt')}
                className="flex items-center gap-1"
              >
                <FileDown size={13} />
                下载 txt
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
