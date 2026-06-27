/**
 * Runtime configuration.
 *
 * Only the home API URL is baked at build time (it's an address, not a secret).
 * The home API KEY is NOT baked — it's fetched from the daemon's session-gated
 * /deployer/runtime-config after login, so the public bundle carries zero
 * secrets. Worker URLs/keys likewise come from the daemon post-auth.
 *
 *   VITE_API_URL=https://xxxx.execute-api.us-east-1.amazonaws.com
 */

import { getSessionToken } from './session';

export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

let _homeKey: string | null = null;
let _homeKeyPromise: Promise<string> | null = null;

/**
 * Home API key, fetched once from the daemon (requires a valid session) and
 * cached in memory. Throws if the daemon is unreachable / unauthenticated.
 */
export async function getHomeApiKey(): Promise<string> {
  if (_homeKey !== null) return _homeKey;
  if (!_homeKeyPromise) {
    _homeKeyPromise = (async (): Promise<string> => {
      const token = getSessionToken();
      const res = await fetch('/deployer/runtime-config', {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`runtime-config HTTP ${res.status}`);
      const j = await res.json();
      const key = (j.homeApiKey as string) || '';
      _homeKey = key;
      return key;
    })().catch((e) => {
      _homeKeyPromise = null; // allow retry
      throw e;
    });
  }
  return _homeKeyPromise;
}

/** Clear the cached home key (e.g. on logout). */
export function clearHomeApiKey(): void {
  _homeKey = null;
  _homeKeyPromise = null;
}

export const isApiConfigured = (): boolean => API_URL.length > 0;
