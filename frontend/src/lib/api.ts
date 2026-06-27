/**
 * Typed client for the AWS Panel Lambda backend.
 *
 * All POST routes carry { credentials: { access_key, secret_key } } in the
 * body and an `x-api-key` header. Response envelope:
 *   { ok: true, data }                — successful
 *   { ok: false, error: { code, message } } — HTTP 4xx/5xx
 *
 * `call()` unwraps the envelope and throws `ApiError` on non-ok payloads
 * so callers can `await api.ec2List(...)` and handle errors with try/catch
 * or via TanStack Query's onError.
 */

import { API_URL, getHomeApiKey } from './config';
import { getWorker, workerCount } from './endpoints';
import { getPinnedRegion } from './bindings';
import { toast } from './toast';
import type { AccountCredentials } from './vault';

// ---------------------------------------------------------------------------
// Response envelope + error
// ---------------------------------------------------------------------------

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string; [k: string]: unknown };
}
type ApiResponse<T> = ApiOk<T> | ApiErr;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Backend response shapes (mirror src/services/*.py)
// ---------------------------------------------------------------------------

export interface VerifyData {
  account_id: string;
  arn: string;
  user_id: string;
  alias: string | null;
  is_root: boolean;
  ak_prefix: string;
  /** ISO-3166 two-letter country code of the account's primary contact. */
  country_code: string | null;
  /** Account creation time (ISO 8601), from the IAM credential report. */
  created_at: string | null;
}

export interface QuotaRegionData {
  region: string;
  quota_code: string;
  value: number | null;
  name: string | null;
  adjustable?: boolean;
}

export interface QuotaPerRegion {
  region: string;
  value: number | null; // On-Demand total quota
  spot: number | null; // Spot total quota
  used: number | null; // On-Demand vCPUs in use
  used_spot: number | null; // Spot vCPUs in use
  name?: string;
  ok: boolean;
  note?: string;
  error?: string;
}

export interface QuotaAllData {
  quota_code: string;
  spot_quota_code?: string;
  regions: QuotaPerRegion[];
  summary: {
    regions_scanned: number;
    regions_with_quota: number;
    total_vcpu: number;
    total_spot: number;
    total_used: number;
    total_used_spot: number;
    max_region: string | null;
    max_value: number | null;
  };
}

export interface Ec2Instance {
  instance_id: string;
  name: string | null;
  type: string;
  state: 'pending' | 'running' | 'shutting-down' | 'terminated' | 'stopping' | 'stopped';
  public_ip: string | null;
  /** 'static' = EIP, 'dynamic' = auto IPv4, 'carrier' = Wavelength carrier IP, null = none. */
  public_ip_type: 'static' | 'dynamic' | 'carrier' | null;
  private_ip: string | null;
  /** All IPv6 addresses across the instance's network interfaces (usually 0 or 1). */
  ipv6_addresses: string[];
  public_dns: string | null;
  region: string;
  az: string | null;
  platform: string;
  architecture: string | null;
  launch_time: string | null;
  key_name: string | null;
  image_id: string | null;
  vpc_id: string | null;
  subnet_id: string | null;
  security_groups: string[];
}

export interface Ec2RegionStatus {
  region: string;
  ok: boolean;
  count?: number;
  error?: string;
}

export interface Ec2ListData {
  instances: Ec2Instance[];
  regions: Ec2RegionStatus[];
  summary: {
    total_instances: number;
    running: number;
    stopped: number;
    regions_scanned: number;
    regions_ok: number;
  };
}

export interface Ec2ListRegionData {
  region: string;
  instances: Ec2Instance[];
}

export interface Ec2ControlData {
  instance_id: string;
  previous_state?: string;
  current_state: string;
}

export interface Ec2ChangeIpData {
  instance_id: string;
  previous_ip: string | null;
  current_ip: string | null;
}

export interface Ec2RenameData {
  instance_id: string;
  name: string | null;
}

export interface Ec2CreateInput {
  region: string;
  instance_type: string;
  architecture?: 'x86_64' | 'arm64';
  /** Image slug from `lib/images.ts` (e.g. 'al2023', 'ubuntu-22.04', 'win-2022-en'). */
  image?: string;
  /** When count > 1, treated as a prefix; instances will be named `<name>-01`, `<name>-02`, … */
  name?: string;
  /** Login password injected via cloud-init for root + ec2-user. */
  password?: string;
  key_name?: string;
  security_group_ids?: string[];
  subnet_id?: string;
  /** Pin the launch to a specific AZ (e.g. 'us-west-2c'). Omit for auto. */
  availability_zone?: string;
  /** Launch into a Wavelength zone (e.g. 'us-west-2-wl1-sfo-wlz-1') — triggers
   *  the carrier-gateway + subnet + carrier-IP setup on the backend. */
  wavelength_zone?: string;
  storage_gb?: number;
  image_id?: string;
  /** Number of instances to launch (1-10). Defaults to 1 on the backend. */
  count?: number;
}

export interface Ec2CreateData {
  instances: Ec2Instance[];
}

export interface Ec2TrafficDaily {
  /** ISO date (YYYY-MM-DD) in UTC. */
  date: string;
  in_bytes: number;
  out_bytes: number;
}

export interface Ec2TrafficData {
  /** Normalized UTC ISO-8601 timestamps the backend actually queried. */
  start: string;
  end: string;
  /** CloudWatch GetMetricStatistics period that was used. */
  period_seconds: number;
  in_bytes: number;
  out_bytes: number;
  total_bytes: number;
  daily: Ec2TrafficDaily[];
}

// ---------------------------------------------------------------------------
// Account-level utilities: billing, free tier, region opt-in
// ---------------------------------------------------------------------------

export interface BillingServiceRow {
  service: string;
  amount: number;
}

export interface MonthlyBillData {
  year: number;
  month: number;
  start: string;
  end: string;
  currency: string;
  total: number;
  services: BillingServiceRow[];
  is_current_month: boolean;
  is_estimate: boolean;
  note?: string;
}

export interface BillingSummaryRow {
  start: string | null;
  end: string | null;
  amount: number;
}

export interface BillingSummaryData {
  months: BillingSummaryRow[];
  currency: string;
}

export interface FreeTierState {
  account_id: string | null;
  plan_type: 'PAID' | 'FREE' | 'UNKNOWN' | string;
  status: 'ACTIVE' | 'EXPIRED' | 'NOT_STARTED' | 'UNKNOWN' | string;
  expiration_date: string | null;
  remaining_credits: { amount: number; unit: string } | null;
  note?: string;
}

export interface FreeTierOffer {
  service: string | null;
  operation: string | null;
  usage_type: string | null;
  region: string | null;
  actual: number;
  forecasted: number;
  limit: number;
  unit: string | null;
  description: string | null;
  tier_type: string | null;
}

export interface FreeTierUsageData {
  offers: FreeTierOffer[];
}

/** Region opt-in status as reported by `account:GetRegionOptStatus`. */
export type RegionOptStatus =
  | 'ENABLED'
  | 'ENABLED_BY_DEFAULT'
  | 'DISABLED'
  | 'ENABLING'
  | 'DISABLING'
  | 'UNKNOWN'
  | string;

export interface RegionAdminRow {
  region: string;
  status: RegionOptStatus;
  opt_in_required: boolean;
}

export interface RegionsAllData {
  regions: RegionAdminRow[];
}

export interface RegionToggleData {
  region: string;
  status: RegionOptStatus;
}

export interface ZoneRow {
  zone_name: string;
  zone_id: string | null;
  /** 'availability-zone' | 'local-zone' | 'wavelength-zone' */
  zone_type: string;
  group_name: string | null;
  /** 'opted-in' | 'not-opted-in' | 'opt-in-not-required' */
  opt_in_status: string;
  parent_zone_name: string | null;
  network_border_group?: string | null;
  state?: string | null;
}

export interface ZonesListData {
  region: string;
  zones: ZoneRow[];
}

export interface ZoneEnableData {
  region: string;
  group_name: string;
  opt_in_status: string;
}

export interface PeeringStatusData {
  region: string;
  ls_peered: boolean;
  /** Whether the region has any Lightsail instance (required to enable peering). */
  has_lightsail: boolean;
  no_default_vpc: boolean;
  peering_id: string | null;
  ls_cidr: string | null;
  routes_ok: boolean;
  route_tables_total: number;
  route_tables_with_route: number;
}

export interface PeeringSetupData {
  region: string;
  peering_id: string;
  ls_cidr: string;
  added: number;
  skipped: number;
  steps: string[];
}

export interface SigninUrlData {
  url: string;
  destination: string;
  duration_seconds: number;
  url_valid_for_seconds: number;
}

export interface IamAccessKeyMeta {
  access_key_id: string | null;
  status: 'Active' | 'Inactive' | string | null;
  user_name: string | null;
  create_date: string | null;
}

export interface IamKeysListData {
  keys: IamAccessKeyMeta[];
}

export interface IamRotateKeyData {
  /** The new AK ID. Save this to the local vault immediately. */
  access_key: string;
  /** The new SK. Returned ONCE — cannot be retrieved later. */
  secret_key: string;
  user_name: string | null;
  create_date: string | null;
}

export interface IamDeleteKeyData {
  deleted_access_key: string;
}

/**
 * One quota pair on a Claude Opus model.
 *   - `applied` = the value AWS has granted this account (may be 0 for new accounts).
 *   - `default` = AWS's published default for this model (account-independent).
 * Displayed as `applied / default` in the modal.
 */
export interface BedrockQuotaPair {
  applied: number | null;
  default: number | null;
}

export interface BedrockOpusModel {
  /** Display name, e.g. "Claude Opus 4.8". */
  name: string;
  /** Cross-region inference profile ID, e.g. "global.anthropic.claude-opus-4-8". */
  id: string;
  /** Bedrock console URL the "调用" button opens. */
  console_url: string;
  /** Combined input+output tokens per minute. */
  tpm: BedrockQuotaPair;
  /** Tokens per 24-hour day. */
  daily: BedrockQuotaPair;
  /** Requests per minute — null for models without an RPM quota (e.g. 4.7/4.8). */
  rpm: BedrockQuotaPair | null;
}

export interface BedrockInfoData {
  region: string;
  /** Per-region cap on simultaneous SageMaker notebook instances. */
  sagemaker_notebook: BedrockQuotaPair;
  claude_opus_models: BedrockOpusModel[];
}


// ---------------------------------------------------------------------------
// Lightsail response shapes
// ---------------------------------------------------------------------------


export type LightsailState =
  | 'pending'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'terminated'
  | 'unknown';

export interface LightsailTag {
  key: string | null;
  value: string | null;
}

export interface LightsailInstance {
  /** Lightsail's immutable instance name — primary key for every API call. */
  instance_name: string;
  /** `Name` tag if present, otherwise `instance_name`. */
  display_name: string;
  state: LightsailState;
  public_ip: string | null;
  private_ip: string | null;
  ipv6_addresses: string[];
  is_static_ip: boolean;
  ip_address_type: string | null;
  region: string | null;
  az: string | null;
  bundle_id: string | null;
  blueprint_id: string | null;
  blueprint_name: string | null;
  username: string | null;
  ssh_key_name: string | null;
  cpu_count: number | null;
  ram_gb: number | null;
  disk_gb: number | null;
  monthly_transfer_gb: number | null;
  created_at: string | null;
  tags: LightsailTag[];
  arn: string | null;
}

export interface LightsailRegionStatus {
  region: string;
  ok: boolean;
  count?: number;
  error?: string;
}

export interface LightsailListData {
  instances: LightsailInstance[];
  regions: LightsailRegionStatus[];
  summary: {
    total_instances: number;
    running: number;
    stopped: number;
    regions_scanned: number;
    regions_ok: number;
  };
}

export interface LightsailListRegionData {
  region: string;
  instances: LightsailInstance[];
}

export interface LightsailControlData {
  instance_name: string;
  current_state: string;
}

export interface LightsailChangeIpData {
  instance_name: string;
  previous_ip: string | null;
  current_ip: string | null;
}

export interface LightsailOpenPortsData {
  instance_name: string;
  ip_address_type: string;
  opened: boolean;
}

export interface LightsailTrafficDaily {
  date: string;
  in_bytes: number;
  out_bytes: number;
}

export interface LightsailTrafficData {
  start: string;
  end: string;
  period_seconds: number;
  in_bytes: number;
  out_bytes: number;
  total_bytes: number;
  daily: LightsailTrafficDaily[];
}

export interface LightsailRenameData {
  instance_name: string;
  display_name: string | null;
}

export interface LightsailCreateInput {
  region: string;
  bundle_id: string;
  blueprint_id: string;
  /** When count > 1, used as a prefix → `<name>-01`, `<name>-02`, …  */
  name?: string;
  password?: string;
  count?: number;
  /** 'ipv4' = single stack v4, 'dualstack' = v4+v6, 'ipv6' = v6-only. */
  ip_address_type?: 'ipv4' | 'dualstack' | 'ipv6';
  /** Optional explicit AZ; backend picks the first available if omitted. */
  availability_zone?: string;
}

export interface LightsailCreateData {
  instances: LightsailInstance[];
}

// ---------------------------------------------------------------------------
// Catalog (bundles + OS blueprints) — pulled live from AWS per region
// ---------------------------------------------------------------------------

export interface LightsailBundleInfo {
  bundle_id: string;
  name: string | null;
  cpu: number | null;
  ram_gb: number | null;
  disk_gb: number | null;
  transfer_gb: number | null;
  price_per_month: number | null;
  /** 'linux' or 'windows' — normalized from AWS's LINUX_UNIX / WINDOWS. */
  platform: 'linux' | 'windows';
  /** 'general' | 'memory' | 'compute' (derived from bundle_id prefix). */
  family: 'general' | 'memory' | 'compute';
  has_public_ipv4: boolean;
  is_ipv6_only: boolean;
}

export interface LightsailBlueprintInfo {
  blueprint_id: string;
  name: string | null;
  platform: 'linux' | 'windows';
  group: string | null;
  version: string | null;
  min_power: number;
}

export interface LightsailCatalogData {
  bundles: LightsailBundleInfo[];
  blueprints: LightsailBlueprintInfo[];
}

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /** Explicit target-region hint. Defaults to `body.region` if present. */
  region?: string;
}

/** Pull a region string out of a request body, if it has one. */
function regionOf(body: unknown): string | null {
  if (body && typeof body === 'object' && 'region' in body) {
    const r = (body as { region?: unknown }).region;
    if (typeof r === 'string' && r) return r;
  }
  return null;
}

/** First 8 chars of the request's access key (account identity for pinning). */
function akPrefixOf(body: unknown): string | null {
  if (body && typeof body === 'object' && 'credentials' in body) {
    const creds = (body as { credentials?: { access_key?: unknown } }).credentials;
    const ak = creds?.access_key;
    if (typeof ak === 'string' && ak.length >= 8) return ak.slice(0, 8);
  }
  return null;
}

/** Low-level fetch + envelope parse against a specific base URL + key. */
async function doFetch<T>(
  base: string,
  key: string,
  path: string,
  opts: CallOptions,
): Promise<T> {
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers['x-api-key'] = key;

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      // We intentionally do NOT send credentials/cookies — this is a
      // public API gated by x-api-key.
    });
  } catch (e) {
    // Network-level failure (DNS, TLS, offline, CORS preflight blocked, …)
    throw new ApiError('NetworkError', (e as Error).message ?? 'request failed', 0);
  }

  // Try to parse JSON; if the body isn't JSON we still want a useful error.
  let payload: ApiResponse<T> | undefined;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError(
      'InvalidResponse',
      `non-JSON response from ${path} (HTTP ${response.status})`,
      response.status,
    );
  }

  if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
    throw new ApiError(
      'InvalidResponse',
      `malformed response envelope from ${path}`,
      response.status,
    );
  }

  if (payload.ok) return payload.data;

  throw new ApiError(payload.error.code, payload.error.message, response.status);
}

/** Transient failures worth retrying on another worker / the home endpoint. */
function isTransient(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  // status 0 = network/TLS/CORS; >=500 = worker server error.
  return e.status === 0 || e.status >= 500;
}

// Throttle the "fell back to home" warning so a flurry of requests during an
// outage doesn't spam toasts.
let _lastHomeWarn = 0;
function warnHomeFallback(): void {
  if (workerCount() === 0) return; // no nodes configured — home is expected
  const now = Date.now();
  if (now - _lastHomeWarn < 30000) return;
  _lastHomeWarn = now;
  toast.warning('节点不可用,本次请求已回退到主区(出口 IP 未分散)。可在 Lambda 页检查节点健康。', {
    title: '已回退主区',
  });
}

/**
 * Region-aware, health-aware request dispatch.
 *
 * Routes to a usable worker for the target region (or any usable worker if the
 * region has none) so the call egresses from a worker IP. Tries one alternate
 * worker on a transient failure, then falls back to the home endpoint — which
 * only happens when no worker can serve the request. A throttled warning fires
 * whenever home is used despite workers being configured.
 */
/** Call the home endpoint, fetching its key from the daemon on first use. */
async function homeFetch<T>(path: string, opts: CallOptions): Promise<T> {
  const key = await getHomeApiKey();
  return doFetch<T>(API_URL, key, path, opts);
}

async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const region = opts.region ?? regionOf(opts.body);
  // An account can be pinned to a fixed egress region; that overrides the
  // operation's target region for *node selection* (the op still runs against
  // its real region — only the egress node changes).
  const pinned = getPinnedRegion(akPrefixOf(opts.body));
  const preferRegion = pinned ?? region;
  const worker = getWorker(preferRegion);

  if (worker) {
    try {
      return await doFetch<T>(worker.url, worker.apiKey, path, opts);
    } catch (e) {
      if (!isTransient(e)) throw e;
      // Try one alternate healthy worker before giving up on workers.
      const alt = getWorker(preferRegion, worker.url);
      if (alt) {
        try {
          return await doFetch<T>(alt.url, alt.apiKey, path, opts);
        } catch (e2) {
          if (isTransient(e2) && API_URL) {
            warnHomeFallback();
            return homeFetch<T>(path, opts);
          }
          throw e2;
        }
      }
      if (API_URL) {
        warnHomeFallback();
        return homeFetch<T>(path, opts);
      }
      throw e;
    }
  }

  if (!API_URL) {
    throw new ApiError('NotConfigured', 'VITE_API_URL is not set', 0);
  }
  warnHomeFallback();
  return homeFetch<T>(path, opts);
}

// ---------------------------------------------------------------------------
// Helpers — credential + region body shaping
// ---------------------------------------------------------------------------

function withCreds(creds: AccountCredentials, extra: Record<string, unknown> = {}) {
  return {
    credentials: {
      access_key: creds.accessKey,
      secret_key: creds.secretKey,
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Client-side region fan-out
//
// When worker nodes exist, listing across regions is done by calling the
// per-region endpoint for EACH region in parallel — each call routes to that
// region's node, so every region's DescribeInstances egresses from its own
// node IP (full multi-IP). With no nodes, we keep the single server-side
// fan-out call (efficient; home).
// ---------------------------------------------------------------------------

async function optedInRegions(creds: AccountCredentials, signal?: AbortSignal): Promise<string[]> {
  const r = await call<{ regions: string[] }>('/regions/list', { body: withCreds(creds), signal });
  return r.regions;
}

async function fanOutEc2(
  creds: AccountCredentials,
  regions: string[] | undefined,
  signal?: AbortSignal,
): Promise<Ec2ListData> {
  const list = regions?.length ? regions : await optedInRegions(creds, signal);
  const results = await Promise.all(
    list.map(async (region) => {
      try {
        const r = await call<Ec2ListRegionData>('/ec2/list-region', {
          body: withCreds(creds, { region }),
          signal,
        });
        return { region, ok: true as const, instances: r.instances };
      } catch (e) {
        return { region, ok: false as const, instances: [] as Ec2Instance[], error: (e as Error).message };
      }
    }),
  );
  const instances = results.flatMap((r) => r.instances);
  return {
    instances,
    regions: results.map((r) => ({
      region: r.region,
      ok: r.ok,
      count: r.ok ? r.instances.length : undefined,
      error: r.ok ? undefined : r.error,
    })),
    summary: {
      total_instances: instances.length,
      running: instances.filter((i) => i.state === 'running').length,
      stopped: instances.filter((i) => i.state === 'stopped').length,
      regions_scanned: results.length,
      regions_ok: results.filter((r) => r.ok).length,
    },
  };
}

async function fanOutLightsail(
  creds: AccountCredentials,
  regions: string[] | undefined,
  signal?: AbortSignal,
): Promise<LightsailListData> {
  const list = regions?.length ? regions : await optedInRegions(creds, signal);
  const results = await Promise.all(
    list.map(async (region) => {
      try {
        const r = await call<LightsailListRegionData>('/lightsail/list-region', {
          body: withCreds(creds, { region }),
          signal,
        });
        return { region, ok: true as const, instances: r.instances };
      } catch (e) {
        return { region, ok: false as const, instances: [] as LightsailInstance[], error: (e as Error).message };
      }
    }),
  );
  const instances = results.flatMap((r) => r.instances);
  return {
    instances,
    regions: results.map((r) => ({
      region: r.region,
      ok: r.ok,
      count: r.ok ? r.instances.length : undefined,
      error: r.ok ? undefined : r.error,
    })),
    summary: {
      total_instances: instances.length,
      running: instances.filter((i) => i.state === 'running').length,
      stopped: instances.filter((i) => i.state === 'stopped').length,
      regions_scanned: results.length,
      regions_ok: results.filter((r) => r.ok).length,
    },
  };
}

async function fetchRegionQuota(
  creds: AccountCredentials,
  region: string,
  signal?: AbortSignal,
): Promise<QuotaPerRegion> {
  try {
    return await call<QuotaPerRegion>('/quota/region-detail', {
      body: withCreds(creds, { region }),
      signal,
    });
  } catch {
    // Old worker without the rich endpoint — fall back to the light value-only one.
    try {
      const v = await call<QuotaRegionData>('/quota/region', {
        body: withCreds(creds, { region }),
        signal,
      });
      return { region, value: v.value, spot: null, used: null, used_spot: null, ok: v.value != null };
    } catch (e) {
      return { region, value: null, spot: null, used: null, used_spot: null, ok: false, error: (e as Error).message };
    }
  }
}

async function fanOutQuota(
  creds: AccountCredentials,
  regions: string[] | undefined,
  signal?: AbortSignal,
): Promise<QuotaAllData> {
  const list = regions?.length ? regions : await optedInRegions(creds, signal);
  const rows = await Promise.all(list.map((r) => fetchRegionQuota(creds, r, signal)));
  rows.sort((a, b) => a.region.localeCompare(b.region));
  const od = rows.filter((r) => r.value != null);
  const total_vcpu = od.reduce((s, r) => s + (r.value || 0), 0);
  const total_spot = rows.reduce((s, r) => s + (r.spot || 0), 0);
  const total_used = rows.reduce((s, r) => s + (r.used || 0), 0);
  const total_used_spot = rows.reduce((s, r) => s + (r.used_spot || 0), 0);
  const max = od.reduce<QuotaPerRegion | null>((m, r) => (!m || (r.value || 0) > (m.value || 0) ? r : m), null);
  return {
    quota_code: 'L-1216C47A',
    spot_quota_code: 'L-34B43A08',
    regions: rows,
    summary: {
      regions_scanned: rows.length,
      regions_with_quota: od.length,
      total_vcpu,
      total_spot,
      total_used,
      total_used_spot,
      max_region: max ? max.region : null,
      max_value: max ? max.value : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Public typed API surface
// ---------------------------------------------------------------------------

export const api = {
  health: (signal?: AbortSignal) =>
    call<{ status: string }>('/health', { method: 'GET', signal }),

  verify: (creds: AccountCredentials, signal?: AbortSignal) =>
    call<VerifyData>('/accounts/verify', { body: withCreds(creds), signal }),

  regionsList: (creds: AccountCredentials, signal?: AbortSignal, refresh = false) =>
    call<{ regions: string[] }>('/regions/list', {
      body: withCreds(creds, refresh ? { refresh: true } : {}),
      signal,
    }),

  quotaRegion: (creds: AccountCredentials, region: string, signal?: AbortSignal) =>
    call<QuotaRegionData>('/quota/region', {
      body: withCreds(creds, { region }),
      signal,
    }),

  quotaAll: (creds: AccountCredentials, regions?: string[], signal?: AbortSignal) =>
    workerCount() > 0
      ? fanOutQuota(creds, regions, signal)
      : call<QuotaAllData>('/quota/all-regions', {
          body: withCreds(creds, regions ? { regions } : {}),
          signal,
    }),

  ec2List: (creds: AccountCredentials, regions?: string[], signal?: AbortSignal) =>
    workerCount() > 0
      ? fanOutEc2(creds, regions, signal)
      : call<Ec2ListData>('/ec2/list', {
          body: withCreds(creds, regions ? { regions } : {}),
          signal,
        }),

  ec2ListRegion: (creds: AccountCredentials, region: string, signal?: AbortSignal) =>
    call<Ec2ListRegionData>('/ec2/list-region', {
      body: withCreds(creds, { region }),
      signal,
    }),

  /**
   * Fetch the latest state of a known set of instances in a single region.
   * Used by the transient-state poller to avoid scanning every region.
   */
  ec2Describe: (
    creds: AccountCredentials,
    region: string,
    instanceIds: string[],
    signal?: AbortSignal,
  ) =>
    call<Ec2ListRegionData>('/ec2/describe', {
      body: withCreds(creds, { region, instance_ids: instanceIds }),
      signal,
    }),

  ec2Start: (
    creds: AccountCredentials,
    region: string,
    instanceId: string,
    signal?: AbortSignal,
  ) =>
    call<Ec2ControlData>('/ec2/start', {
      body: withCreds(creds, { region, instance_id: instanceId }),
      signal,
    }),

  ec2Stop: (
    creds: AccountCredentials,
    region: string,
    instanceId: string,
    force = false,
    signal?: AbortSignal,
  ) =>
    call<Ec2ControlData>('/ec2/stop', {
      body: withCreds(creds, { region, instance_id: instanceId, force }),
      signal,
    }),

  ec2Reboot: (
    creds: AccountCredentials,
    region: string,
    instanceId: string,
    signal?: AbortSignal,
  ) =>
    call<Ec2ControlData>('/ec2/reboot', {
      body: withCreds(creds, { region, instance_id: instanceId }),
      signal,
    }),

  ec2ChangeIp: (
    creds: AccountCredentials,
    region: string,
    instanceId: string,
    signal?: AbortSignal,
  ) =>
    call<Ec2ChangeIpData>('/ec2/change-ip', {
      body: withCreds(creds, { region, instance_id: instanceId }),
      signal,
    }),

  ec2Terminate: (
    creds: AccountCredentials,
    region: string,
    instanceId: string,
    signal?: AbortSignal,
  ) =>
    call<Ec2ControlData>('/ec2/terminate', {
      body: withCreds(creds, { region, instance_id: instanceId }),
      signal,
    }),

  ec2Rename: (
    creds: AccountCredentials,
    region: string,
    instanceId: string,
    name: string,
    signal?: AbortSignal,
  ) =>
    call<Ec2RenameData>('/ec2/rename', {
      body: withCreds(creds, { region, instance_id: instanceId, name }),
      signal,
    }),

  ec2Create: (creds: AccountCredentials, input: Ec2CreateInput, signal?: AbortSignal) =>
    call<Ec2CreateData>('/ec2/create', {
      body: withCreds(creds, input as unknown as Record<string, unknown>),
      signal,
    }),

  /**
   * Query CloudWatch traffic (NetworkIn + NetworkOut) for a single instance.
   * `start` / `end` are ISO-8601 strings (UTC recommended). The backend caps
   * the range at 455 days.
   */
  ec2Traffic: (
    creds: AccountCredentials,
    region: string,
    instanceId: string,
    start: string,
    end: string,
    signal?: AbortSignal,
  ) =>
    call<Ec2TrafficData>('/ec2/traffic', {
      body: withCreds(creds, { region, instance_id: instanceId, start, end }),
      signal,
    }),

  // -------------------------------------------------------------------------
  // Lightsail
  // -------------------------------------------------------------------------

  lightsailList: (
    creds: AccountCredentials,
    regions?: string[],
    signal?: AbortSignal,
  ) =>
    workerCount() > 0
      ? fanOutLightsail(creds, regions, signal)
      : call<LightsailListData>('/lightsail/list', {
          body: withCreds(creds, regions ? { regions } : {}),
          signal,
        }),

  lightsailListRegion: (
    creds: AccountCredentials,
    region: string,
    signal?: AbortSignal,
  ) =>
    call<LightsailListRegionData>('/lightsail/list-region', {
      body: withCreds(creds, { region }),
      signal,
    }),

  /** Per-region transient-state poller. */
  lightsailDescribe: (
    creds: AccountCredentials,
    region: string,
    instanceNames: string[],
    signal?: AbortSignal,
  ) =>
    call<LightsailListRegionData>('/lightsail/describe', {
      body: withCreds(creds, { region, instance_names: instanceNames }),
      signal,
    }),

  lightsailStart: (
    creds: AccountCredentials,
    region: string,
    instanceName: string,
    signal?: AbortSignal,
  ) =>
    call<LightsailControlData>('/lightsail/start', {
      body: withCreds(creds, { region, instance_name: instanceName }),
      signal,
    }),

  lightsailStop: (
    creds: AccountCredentials,
    region: string,
    instanceName: string,
    force = false,
    signal?: AbortSignal,
  ) =>
    call<LightsailControlData>('/lightsail/stop', {
      body: withCreds(creds, { region, instance_name: instanceName, force }),
      signal,
    }),

  lightsailReboot: (
    creds: AccountCredentials,
    region: string,
    instanceName: string,
    signal?: AbortSignal,
  ) =>
    call<LightsailControlData>('/lightsail/reboot', {
      body: withCreds(creds, { region, instance_name: instanceName }),
      signal,
    }),

  lightsailDelete: (
    creds: AccountCredentials,
    region: string,
    instanceName: string,
    signal?: AbortSignal,
  ) =>
    call<LightsailControlData>('/lightsail/delete', {
      body: withCreds(creds, { region, instance_name: instanceName }),
      signal,
    }),

  lightsailRename: (
    creds: AccountCredentials,
    region: string,
    instanceName: string,
    displayName: string,
    signal?: AbortSignal,
  ) =>
    call<LightsailRenameData>('/lightsail/rename', {
      body: withCreds(creds, {
        region,
        instance_name: instanceName,
        display_name: displayName,
      }),
      signal,
    }),

  /**
   * Rotate the dynamic public IPv4 of a Lightsail instance via the
   * Static IP juggle (allocate → attach → detach → release). Rejects
   * non-running, EIP-locked, and IPv6-only instances.
   */
  lightsailChangeIp: (
    creds: AccountCredentials,
    region: string,
    instanceName: string,
    signal?: AbortSignal,
  ) =>
    call<LightsailChangeIpData>('/lightsail/change-ip', {
      body: withCreds(creds, { region, instance_name: instanceName }),
      signal,
    }),

  /**
   * Re-apply the "all ports open" firewall ruleset to an existing instance
   * (auto-detects ipv4 / dualstack / ipv6). Used by the frontend to finish
   * opening ports once a freshly-created instance reaches "running" — at
   * create time the instance is still "pending" and Lightsail rejects the
   * firewall change. Idempotent.
   */
  lightsailOpenPorts: (
    creds: AccountCredentials,
    region: string,
    instanceName: string,
    signal?: AbortSignal,
  ) =>
    call<LightsailOpenPortsData>('/lightsail/open-ports', {
      body: withCreds(creds, { region, instance_name: instanceName }),
      signal,
    }),

  /**
   * Query Lightsail instance traffic (NetworkIn + NetworkOut, Sum) over an
   * ISO-8601 time range. Mirrors the EC2 traffic endpoint but uses
   * Lightsail's own GetInstanceMetricData under the hood. Range cap: 455 days.
   */
  lightsailTraffic: (
    creds: AccountCredentials,
    region: string,
    instanceName: string,
    start: string,
    end: string,
    signal?: AbortSignal,
  ) =>
    call<LightsailTrafficData>('/lightsail/traffic', {
      body: withCreds(creds, {
        region,
        instance_name: instanceName,
        start,
        end,
      }),
      signal,
    }),

  lightsailCreate: (
    creds: AccountCredentials,
    input: LightsailCreateInput,
    signal?: AbortSignal,
  ) =>
    call<LightsailCreateData>('/lightsail/create', {
      body: withCreds(creds, input as unknown as Record<string, unknown>),
      signal,
    }),

  /**
   * Live Lightsail bundle + OS-blueprint catalog for one region. Backend
   * caches the response in the warm Lambda environment; passing
   * `refresh=true` bypasses that cache.
   */
  lightsailCatalog: (
    creds: AccountCredentials,
    region: string,
    refresh = false,
    signal?: AbortSignal,
  ) =>
    call<LightsailCatalogData>('/lightsail/catalog', {
      body: withCreds(creds, refresh ? { region, refresh: true } : { region }),
      signal,
    }),

  // -------------------------------------------------------------------------
  // Account-level utilities: billing, free tier, region opt-in
  // -------------------------------------------------------------------------

  /** Get a specific month's bill broken down by service (defaults: current month). */
  billingMonthly: (
    creds: AccountCredentials,
    year?: number,
    month?: number,
    signal?: AbortSignal,
  ) =>
    call<MonthlyBillData>('/billing/monthly', {
      body: withCreds(creds, {
        ...(year != null ? { year } : {}),
        ...(month != null ? { month } : {}),
      }),
      signal,
    }),

  /** Recent N-month total spend (default 6). Used for trend lines. */
  billingSummary: (creds: AccountCredentials, months = 6, signal?: AbortSignal) =>
    call<BillingSummaryData>('/billing/summary', {
      body: withCreds(creds, { months }),
      signal,
    }),

  /** Free Tier plan state — primarily the remaining $200 credit balance. */
  freeTierState: (creds: AccountCredentials, signal?: AbortSignal) =>
    call<FreeTierState>('/free-tier/state', { body: withCreds(creds), signal }),

  /** Detailed per-offer Free Tier usage (12-month tier accounts). */
  freeTierUsage: (creds: AccountCredentials, signal?: AbortSignal) =>
    call<FreeTierUsageData>('/free-tier/usage', { body: withCreds(creds), signal }),

  /** List every AWS region with its opt-in status. */
  regionsAll: (creds: AccountCredentials, signal?: AbortSignal) =>
    call<RegionsAllData>('/regions/all', { body: withCreds(creds), signal }),

  /** Enable an opt-in region (async — status returns ENABLING). */
  regionEnable: (creds: AccountCredentials, region: string, signal?: AbortSignal) =>
    call<RegionToggleData>('/regions/enable', {
      body: withCreds(creds, { region }),
      signal,
    }),

  /** Disable an opt-in region (async — status returns DISABLING). */
  regionDisable: (creds: AccountCredentials, region: string, signal?: AbortSignal) =>
    call<RegionToggleData>('/regions/disable', {
      body: withCreds(creds, { region }),
      signal,
    }),

  /** List AZ / Local / Wavelength zones within one region (lazy per-region). */
  zonesList: (creds: AccountCredentials, region: string, signal?: AbortSignal) =>
    call<ZonesListData>('/zones/list', {
      body: withCreds(creds, { region }),
      signal,
    }),

  /**
   * Opt into a Local/Wavelength zone group (enable-only — AWS doesn't
   * allow opting out via API). Enabling one Wavelength zone enables the
   * whole regional `wl1` group.
   */
  zoneEnable: (
    creds: AccountCredentials,
    region: string,
    groupName: string,
    signal?: AbortSignal,
  ) =>
    call<ZoneEnableData>('/zones/enable', {
      body: withCreds(creds, { region, group_name: groupName }),
      signal,
    }),

  /** Check Lightsail VPC peering + default-VPC route status for a region. */
  peeringStatus: (creds: AccountCredentials, region: string, signal?: AbortSignal) =>
    call<PeeringStatusData>('/peering/status', {
      body: withCreds(creds, { region }),
      signal,
    }),

  /**
   * One-click: enable Lightsail VPC peering + add return routes to every
   * route table in the default VPC. Idempotent / re-runnable — also fixes
   * up Wavelength subnet route tables created after the first peering.
   */
  peeringSetup: (creds: AccountCredentials, region: string, signal?: AbortSignal) =>
    call<PeeringSetupData>('/peering/setup', {
      body: withCreds(creds, { region }),
      signal,
    }),

  /**
   * Generate a 1-hour federation sign-in URL for the AWS Console.
   * Requires IAM user AK/SK — root will return a BadRequest with a
   * friendly message.
   */
  iamSigninUrl: (
    creds: AccountCredentials,
    destination?: string,
    durationSeconds = 3600,
    signal?: AbortSignal,
  ) =>
    call<SigninUrlData>('/iam/signin-url', {
      body: withCreds(creds, {
        ...(destination ? { destination } : {}),
        duration_seconds: durationSeconds,
      }),
      signal,
    }),

  /** Get Bedrock / Claude foundation models + inference profiles for one region. */
  bedrockInfo: (
    creds: AccountCredentials,
    region: string,
    signal?: AbortSignal,
  ) =>
    call<BedrockInfoData>('/bedrock/info', {
      body: withCreds(creds, { region }),
      signal,
    }),

  // -------------------------------------------------------------------------
  // IAM key rotation — two-call protocol so the frontend can persist the
  // new key locally between create and delete. See backend
  // `services/key_rotate.py` for the rationale.
  // -------------------------------------------------------------------------

  /** List access keys for the calling identity (root or IAM user). */
  iamKeysList: (creds: AccountCredentials, signal?: AbortSignal) =>
    call<IamKeysListData>('/iam/keys/list', { body: withCreds(creds), signal }),

  /**
   * Create a NEW access key without deleting the old one. The returned
   * `secret_key` is only ever shown by AWS once — persist it to the local
   * vault immediately and `iamKeysDelete` the old AK once saved.
   */
  iamKeysRotate: (creds: AccountCredentials, signal?: AbortSignal) =>
    call<IamRotateKeyData>('/iam/keys/rotate', { body: withCreds(creds), signal }),

  /**
   * Delete the given access key. The request is signed by `creds`; passing
   * the NEW AK here serves as a smoke-test that it works before we
   * permanently discard the OLD one. Backend retries InvalidClientTokenId
   * for ~15s to absorb AK propagation lag.
   */
  iamKeysDelete: (
    creds: AccountCredentials,
    accessKeyId: string,
    signal?: AbortSignal,
  ) =>
    call<IamDeleteKeyData>('/iam/keys/delete', {
      body: withCreds(creds, { access_key_id: accessKeyId }),
      signal,
    }),
};
