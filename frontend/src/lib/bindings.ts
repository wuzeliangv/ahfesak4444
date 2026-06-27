/**
 * Account → node (region) egress bindings, used by the router (api.ts) to pin
 * an account's requests to a worker in a chosen region.
 *
 * The binding now lives on the server-side account record (pinnedRegion).
 * Here we keep a fast in-memory akPrefix→region map, rebuilt whenever the
 * account list is fetched (see vault.listAccounts). The router reads it via
 * the access-key prefix in each request body.
 */

let _map = new Map<string, string>();

export interface BindableAccount {
  verified?: { akPrefix?: string | null } | null;
  pinnedRegion?: string | null;
}

/** Rebuild the akPrefix→region map from the current account list. */
export function setBindingsFromAccounts(accounts: BindableAccount[]): void {
  const m = new Map<string, string>();
  for (const a of accounts) {
    const prefix = a.verified?.akPrefix;
    if (prefix && a.pinnedRegion) m.set(prefix, a.pinnedRegion);
  }
  _map = m;
}

/** Region this account (by AK prefix) is pinned to, or null for automatic. */
export function getPinnedRegion(akPrefix?: string | null): string | null {
  if (!akPrefix) return null;
  return _map.get(akPrefix) || null;
}
