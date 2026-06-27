/**
 * Account access layer — now backed by the local daemon (route S).
 *
 * AWS credentials are stored encrypted server-side (DEK) by the daemon and
 * fetched on demand for the authenticated session. This module keeps the same
 * function names the rest of the app already uses, so consumers are unchanged;
 * only the implementation moved from the browser IndexedDB vault to the daemon.
 *
 * Auth is the session token (see lib/session); there's no master password.
 */

import { accountsApi } from './deployer';
import type { AccountRecord, DeployerAccountRecord, GroupRecord, QuotaCache, VerifiedMeta } from './db';
import { setBindingsFromAccounts } from './bindings';
import { clearSessionToken } from './session';
import { clearHomeApiKey } from './config';

export interface AccountCredentials {
  accessKey: string;
  secretKey: string;
}

export interface AccountInput {
  alias: string;
  accessKey: string;
  secretKey: string;
  defaultRegion: string;
  group?: string;
  note?: string;
  color?: string;
  pinnedRegion?: string | null;
  monitorVcpu?: boolean;
  verified?: Omit<VerifiedMeta, 'verifiedAt'>;
}

export interface DeployerAccountInput {
  alias: string;
  accessKey: string;
  secretKey: string;
  defaultRegion: string;
  note?: string;
  verified?: Omit<VerifiedMeta, 'verifiedAt'>;
}

// ---------------------------------------------------------------------------
// In-memory credential cache (avoids a round-trip per AWS operation). Cleared
// when an account changes. Creds live only in memory for the session.
// ---------------------------------------------------------------------------
const _credCache = new Map<string, AccountCredentials>();
const _hostCredCache = new Map<string, AccountCredentials>();

function toRecord(m: {
  id: string;
  alias: string;
  group: string | null;
  note: string | null;
  defaultRegion: string;
  color: string | null;
  verified: unknown;
  quota: unknown;
  pinnedRegion: string | null;
  monitorVcpu?: boolean;
  vcpuValue?: number | null;
  vcpuCheckedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}): AccountRecord {
  return {
    id: m.id,
    alias: m.alias,
    group: m.group,
    note: m.note,
    defaultRegion: m.defaultRegion,
    color: m.color,
    verified: (m.verified as VerifiedMeta | null) ?? null,
    quota: (m.quota as QuotaCache | null) ?? null,
    pinnedRegion: m.pinnedRegion,
    monitorVcpu: !!m.monitorVcpu,
    vcpuValue: m.vcpuValue ?? null,
    vcpuCheckedAt: m.vcpuCheckedAt ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
export async function listAccounts(): Promise<AccountRecord[]> {
  const { accounts } = await accountsApi.list();
  const records = accounts.map(toRecord);
  // Keep the router's egress-binding map in sync with the latest accounts.
  setBindingsFromAccounts(records);
  return records;
}

export async function addAccount(input: AccountInput): Promise<AccountRecord> {
  const meta = await accountsApi.add({
    alias: input.alias,
    accessKey: input.accessKey,
    secretKey: input.secretKey,
    defaultRegion: input.defaultRegion,
    group: input.group ?? null,
    note: input.note ?? null,
    color: input.color ?? null,
    pinnedRegion: input.pinnedRegion ?? null,
    verified: input.verified ?? null,
  });
  return toRecord(meta);
}

export async function updateAccount(
  id: string,
  patch: Partial<AccountInput>,
): Promise<AccountRecord> {
  const body: Record<string, unknown> = { id };
  for (const f of ['alias', 'group', 'note', 'defaultRegion', 'color', 'pinnedRegion', 'monitorVcpu', 'verified'] as const) {
    if (patch[f] !== undefined) body[f] = patch[f];
  }
  if (patch.accessKey !== undefined) body.accessKey = patch.accessKey;
  if (patch.secretKey !== undefined) body.secretKey = patch.secretKey;
  const meta = await accountsApi.update(body);
  _credCache.delete(id); // creds may have changed
  return toRecord(meta);
}

export async function setAccountQuota(id: string, quota: QuotaCache): Promise<AccountRecord> {
  const meta = await accountsApi.quota(id, quota as unknown as Record<string, unknown>);
  return toRecord(meta);
}

export async function deleteAccount(id: string): Promise<void> {
  await accountsApi.remove(id);
  _credCache.delete(id);
}

export async function getAccountCredentials(id: string): Promise<AccountCredentials> {
  const cached = _credCache.get(id);
  if (cached) return cached;
  const creds = await accountsApi.creds(id);
  _credCache.set(id, creds);
  return creds;
}

/**
 * Restore accounts from a backup (the daemon's import endpoint already
 * accepts every field — alias/group/note/region/color/pinnedRegion/
 * monitorVcpu/verified/quota — and re-creates referenced groups). Invalid
 * rows (missing AK/SK/region) are skipped server-side.
 */
export async function importAccounts(
  items: Array<Record<string, unknown>>,
): Promise<{ imported: number; skipped: number }> {
  return accountsApi.import(items);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------
export async function listGroups(): Promise<GroupRecord[]> {
  const { groups } = await accountsApi.list();
  return groups.slice().sort((a, b) => a.createdAt - b.createdAt);
}

export async function addGroup(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) throw new Error('分组名称不能为空');
  await accountsApi.groupAdd(clean);
}

export async function deleteGroup(name: string): Promise<void> {
  await accountsApi.groupDelete(name);
}

export async function renameGroup(
  oldName: string,
  newName: string,
): Promise<{ accountsUpdated: number }> {
  const cleanOld = oldName.trim();
  const cleanNew = newName.trim();
  if (!cleanOld) throw new Error('原分组名无效');
  if (!cleanNew) throw new Error('新分组名不能为空');
  if (cleanOld === cleanNew) return { accountsUpdated: 0 };
  const r = await accountsApi.groupRename(cleanOld, cleanNew);
  return { accountsUpdated: r.accountsUpdated };
}

// ---------------------------------------------------------------------------
// Deployer (host) accounts — separate set used to host worker Lambdas
// ---------------------------------------------------------------------------
function toDeployerRecord(m: {
  id: string;
  alias: string;
  defaultRegion: string;
  note: string | null;
  verified: unknown;
  createdAt: number;
  updatedAt: number;
}): DeployerAccountRecord {
  return {
    id: m.id,
    alias: m.alias,
    defaultRegion: m.defaultRegion,
    note: m.note,
    verified: (m.verified as VerifiedMeta | null) ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

export async function listDeployerAccounts(): Promise<DeployerAccountRecord[]> {
  const { accounts } = await accountsApi.hostList();
  return accounts.map(toDeployerRecord);
}

export async function addDeployerAccount(
  input: DeployerAccountInput,
): Promise<DeployerAccountRecord> {
  const meta = await accountsApi.hostAdd({
    alias: input.alias,
    accessKey: input.accessKey,
    secretKey: input.secretKey,
    defaultRegion: input.defaultRegion,
    note: input.note ?? null,
    verified: input.verified ?? null,
  });
  return toDeployerRecord(meta);
}

export async function deleteDeployerAccount(id: string): Promise<void> {
  await accountsApi.hostRemove(id);
  _hostCredCache.delete(id);
}

export async function getDeployerAccountCredentials(id: string): Promise<AccountCredentials> {
  const cached = _hostCredCache.get(id);
  if (cached) return cached;
  const creds = await accountsApi.hostCreds(id);
  _hostCredCache.set(id, creds);
  return creds;
}

// ---------------------------------------------------------------------------
// Session / logout
// ---------------------------------------------------------------------------

/** Log out: clear the session token and return to the public homepage. */
export function lockVault(): void {
  clearSessionToken();
  clearHomeApiKey();
  _credCache.clear();
  _hostCredCache.clear();
  try {
    window.location.href = '/';
  } catch {
    /* ignore */
  }
}
