/**
 * Client for the local deployer daemon (proxied by Caddy at /deployer/*).
 *
 * The daemon drives `sam` to deploy / tear down worker Lambdas into target
 * accounts/regions. Long-running operations stream Server-Sent Events back;
 * because we must POST credentials in the body (and EventSource is GET-only),
 * we consume the SSE stream via fetch + ReadableStream rather than EventSource.
 *
 * Auth: the same x-api-key the rest of the panel uses (baked VITE_API_KEY).
 * The daemon reads the matching value from backend/.api-key.
 */

import { getSessionToken } from './session';

const BASE = '/deployer';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Liveness info attached to each deployment by the daemon's health probe. */
export interface NodeHealth {
  status: 'up' | 'down' | 'unknown';
  lastOkAt: string | null;
  lastCheckAt: string | null;
  latencyMs: number | null;
  consecutiveFails: number;
}

/** A worker endpoint recorded by the daemon after a successful deploy. */
export interface DeploymentEntry {
  id: string; // `${accountId}:${region}`
  alias: string | null;
  accountId: string;
  accountRef: string | null; // vault account id (for credential lookup on destroy)
  region: string;
  stackName: string;
  url: string;
  apiKey: string;
  deployedAt: string;
  health?: NodeHealth;
}

export interface DeploymentRegistry {
  version: number;
  deployments: DeploymentEntry[];
}

/** One deploy target: an account's creds + a region. */
export interface DeployTarget {
  alias?: string;
  accountRef?: string; // vault account id, echoed into the registry
  region: string;
  accessKey: string;
  secretKey: string;
}

export interface DestroyTarget {
  region: string;
  accountId?: string;
  accessKey: string;
  secretKey: string;
}

/** One account to scan for existing worker stacks. */
export interface ScanAccount {
  accountRef?: string;
  alias?: string;
  accessKey: string;
  secretKey: string;
}

/** A worker stack discovered by a scan. */
export interface ScanFound {
  accountRef: string | null;
  alias: string | null;
  accountId: string;
  region: string;
  status: string;
  url: string | null;
}

/** A parsed SSE event from the daemon. */
export interface DeployerEvent {
  event: string; // 'phase' | 'log' | 'target-start' | 'target-done' | 'target-error' | 'done'
  data: any;
}

// ---------------------------------------------------------------------------
// Plain JSON calls
// ---------------------------------------------------------------------------

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const t = getSessionToken();
  if (t) h['authorization'] = `Bearer ${t}`;
  return h;
}

/** Validate the current session token. 'invalid' = expired/revoked (kick to homepage). */
export async function checkSession(): Promise<'ok' | 'invalid' | 'error'> {
  const t = getSessionToken();
  if (!t) return 'invalid';
  try {
    const res = await fetch(`${BASE}/auth/check`, {
      headers: { authorization: `Bearer ${t}` },
    });
    if (res.ok) return 'ok';
    if (res.status === 401) return 'invalid';
    return 'error';
  } catch {
    return 'error';
  }
}

export async function deployerHealth(): Promise<{ status: string; gateKeyLoaded: boolean; stackName: string }> {
  const res = await fetch(`${BASE}/health`, { headers: headers() });
  if (!res.ok) throw new Error(`deployer health HTTP ${res.status}`);
  return res.json();
}

export async function listDeployments(signal?: AbortSignal): Promise<DeploymentRegistry> {
  const res = await fetch(`${BASE}/deployments`, { headers: headers(), signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.message || j.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

/** Force an immediate health probe of all nodes; returns the registry with health. */
export async function probeNodes(signal?: AbortSignal): Promise<DeploymentRegistry> {
  const res = await fetch(`${BASE}/probe`, { method: 'POST', headers: headers(), signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.message || j.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Notification config (Telegram)
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  chatId: string;
  tokenSet: boolean;
}

export async function getDeployerConfig(
  signal?: AbortSignal,
): Promise<{ telegram: TelegramConfig }> {
  const res = await fetch(`${BASE}/config`, { headers: headers(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Save Telegram config. Leave botToken empty to keep the existing token. */
export async function setDeployerConfig(opts: {
  botToken?: string;
  chatId: string;
}): Promise<{ telegram: TelegramConfig }> {
  const res = await fetch(`${BASE}/config`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ telegram: { botToken: opts.botToken ?? '', chatId: opts.chatId } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.message || j.error || `HTTP ${res.status}`);
  return j;
}

export async function clearDeployerConfig(): Promise<void> {
  const res = await fetch(`${BASE}/config`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ clear: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Send a test message with the saved config. Returns {ok, error?}. */
export async function testTelegram(): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${BASE}/config/test`, { method: 'POST', headers: headers() });
  return res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
}

// ---------------------------------------------------------------------------
// Account store (server-side, DEK-encrypted)
// ---------------------------------------------------------------------------

async function dGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function dPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j as any).message || (j as any).error || `HTTP ${res.status}`);
  return j as T;
}

export interface AccountMetaDTO {
  id: string;
  alias: string;
  group: string | null;
  note: string | null;
  defaultRegion: string;
  color: string | null;
  verified: any | null;
  quota: any | null;
  pinnedRegion: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface GroupDTO {
  name: string;
  createdAt: number;
}
export interface DeployerAccountMetaDTO {
  id: string;
  alias: string;
  defaultRegion: string;
  note: string | null;
  verified: any | null;
  createdAt: number;
  updatedAt: number;
}

export const accountsApi = {
  list: () => dGet<{ accounts: AccountMetaDTO[]; groups: GroupDTO[] }>('/accounts'),
  add: (input: Record<string, unknown>) => dPost<AccountMetaDTO>('/accounts/add', input),
  update: (input: Record<string, unknown>) => dPost<AccountMetaDTO>('/accounts/update', input),
  remove: (id: string) => dPost<{ ok: true }>('/accounts/delete', { id }),
  creds: (id: string) => dPost<{ accessKey: string; secretKey: string }>('/accounts/creds', { id }),
  quota: (id: string, quota: Record<string, unknown>) =>
    dPost<AccountMetaDTO>('/accounts/quota', { id, quota }),
  import: (accounts: Record<string, unknown>[]) =>
    dPost<{ imported: number; skipped: number }>('/accounts/import', { accounts }),
  groupAdd: (name: string) => dPost<{ ok: true }>('/groups/add', { name }),
  groupDelete: (name: string) => dPost<{ ok: true }>('/groups/delete', { name }),
  groupRename: (oldName: string, newName: string) =>
    dPost<{ ok: true; accountsUpdated: number }>('/groups/rename', { oldName, newName }),
  // Deployer (host) accounts
  hostList: () => dGet<{ accounts: DeployerAccountMetaDTO[] }>('/deployer-accounts'),
  hostAdd: (input: Record<string, unknown>) =>
    dPost<DeployerAccountMetaDTO>('/deployer-accounts/add', input),
  hostRemove: (id: string) => dPost<{ ok: true }>('/deployer-accounts/delete', { id }),
  hostCreds: (id: string) =>
    dPost<{ accessKey: string; secretKey: string }>('/deployer-accounts/creds', { id }),
};

// ---------------------------------------------------------------------------
// SSE-over-fetch streaming
// ---------------------------------------------------------------------------

function parseEventBlock(raw: string): DeployerEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // keep-alive comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(joined) };
  } catch {
    return { event, data: joined };
  }
}

async function streamSSE(
  path: string,
  body: unknown,
  onEvent: (ev: DeployerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    signal,
  });

  // Errors (401/400/…) come back as a normal JSON envelope, not a stream.
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      msg = j.message || j.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseEventBlock(raw);
      if (ev) onEvent(ev);
    }
  }
  // Flush any trailing event without a terminating blank line.
  if (buf.trim()) {
    const ev = parseEventBlock(buf);
    if (ev) onEvent(ev);
  }
}

/** Deploy one or more targets; streams progress via `onEvent`. */
export function deploy(
  targets: DeployTarget[],
  onEvent: (ev: DeployerEvent) => void,
  opts?: { corsOrigin?: string; signal?: AbortSignal },
): Promise<void> {
  return streamSSE('/deploy', { targets, corsOrigin: opts?.corsOrigin }, onEvent, opts?.signal);
}

/** Tear down one worker (sam delete); streams progress via `onEvent`. */
export function destroy(
  target: DestroyTarget,
  onEvent: (ev: DeployerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSSE('/destroy', target, onEvent, signal);
}

/**
 * Scan the given accounts for existing worker stacks; streams
 * scan-progress / scan-found / done events. The daemon scans each account's
 * enabled regions (skipping disabled opt-in regions). Used to re-adopt nodes
 * after a local registry loss.
 */
export function scan(
  accounts: ScanAccount[],
  onEvent: (ev: DeployerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSSE('/scan', { accounts }, onEvent, signal);
}
