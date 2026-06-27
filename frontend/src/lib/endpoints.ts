/**
 * Worker endpoint registry + health-aware, region-aware routing.
 *
 * Business requests that target a specific AWS region are routed to a worker
 * Lambda for that region (using that worker's own key) so the call egresses
 * from that region's IP. This module decides which worker to use.
 *
 * Selection order (see getWorker):
 *   1. a usable worker in the target region (round-robin if several)
 *   2. any usable worker in any region (round-robin) — keeps traffic off the
 *      home endpoint even when the target region has no node
 *   3. null → caller falls back to the home endpoint (only when there are no
 *      usable workers at all)
 *
 * "usable" = health status is not 'down' ('up' and 'unknown' both count, so a
 * freshly-loaded-but-not-yet-probed node is still routable). Health comes from
 * the daemon's probe loop via GET /deployer/deployments. The map is refreshed
 * on a timer so routing tracks health changes. If the daemon is unreachable
 * the map stays empty and everything transparently uses home.
 */

import { listDeployments } from './deployer';

export type NodeStatus = 'up' | 'down' | 'unknown';

export interface WorkerEndpoint {
  url: string;
  apiKey: string;
  region: string;
  status: NodeStatus;
}

let _all: WorkerEndpoint[] = [];
const _rr = new Map<string, number>();
let _loaded = false;
let _loading: Promise<void> | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;

const REFRESH_MS = 60000;

/** Rebuild the worker list (with health) from the daemon registry. Never throws. */
export async function refreshEndpoints(): Promise<void> {
  try {
    const reg = await listDeployments();
    _all = reg.deployments
      .filter((d) => d.url && d.apiKey && d.region)
      .map((d) => ({
        url: d.url,
        apiKey: d.apiKey,
        region: d.region,
        status: (d.health?.status ?? 'unknown') as NodeStatus,
      }));
    _loaded = true;
  } catch {
    // Daemon unreachable / not configured — keep using home for everything.
    _loaded = true;
  }
}

/** Kick off a one-time load + a periodic refresh so routing tracks health. */
export function ensureEndpointsLoaded(): void {
  if (!_loaded && !_loading) {
    _loading = refreshEndpoints().finally(() => {
      _loading = null;
    });
  }
  if (!_timer) {
    _timer = setInterval(() => {
      void refreshEndpoints();
    }, REFRESH_MS);
  }
}

function usable(list: WorkerEndpoint[]): WorkerEndpoint[] {
  return list.filter((w) => w.status !== 'down');
}

function rrPick(key: string, list: WorkerEndpoint[]): WorkerEndpoint | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const i = (_rr.get(key) ?? 0) % list.length;
  _rr.set(key, i + 1);
  return list[i];
}

/**
 * Pick a usable worker for `region`, preferring the region itself and falling
 * back to any region. `excludeUrl` skips a worker that just failed (used for
 * the retry path). Returns null only when no usable worker exists at all.
 */
export function getWorker(region?: string | null, excludeUrl?: string): WorkerEndpoint | null {
  const pool = excludeUrl ? _all.filter((w) => w.url !== excludeUrl) : _all;
  if (region) {
    const inRegion = usable(pool.filter((w) => w.region === region));
    const pick = rrPick(`r:${region}`, inRegion);
    if (pick) return pick;
  }
  return rrPick('*', usable(pool));
}

/** Regions that currently have at least one usable worker (for UI display). */
export function routedRegions(): string[] {
  return [...new Set(usable(_all).map((w) => w.region))].sort();
}

export function workerCount(): number {
  return _all.length;
}

export function healthyWorkerCount(): number {
  return usable(_all).length;
}
