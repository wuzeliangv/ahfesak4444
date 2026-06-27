/**
 * Panel access session (token issued by the Telegram /login bot).
 *
 * The token arrives in the URL hash (#token=…); we capture it, stash it in
 * localStorage, and immediately strip it from the address bar. From then on
 * every daemon request carries it as `Authorization: Bearer …`. A 30-day TTL
 * lives server-side; the daemon's /auth/check tells us when it has expired.
 */

const KEY = 'aws-panel-session';
let _mem: string | null = null;

export function getSessionToken(): string | null {
  if (_mem) return _mem;
  try {
    _mem = localStorage.getItem(KEY);
  } catch {
    _mem = null;
  }
  return _mem;
}

export function setSessionToken(token: string): void {
  _mem = token;
  try {
    localStorage.setItem(KEY, token);
  } catch {
    /* storage disabled — keep in memory only */
  }
}

export function clearSessionToken(): void {
  _mem = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * If the URL hash carries `token=…`, store it and scrub it from the address
 * bar (so it doesn't linger in history / get shoulder-surfed). Returns the
 * effective session token (freshly captured or previously stored), if any.
 */
export function consumeUrlToken(): string | null {
  const m = (window.location.hash || '').match(/token=([A-Za-z0-9_-]+)/);
  if (m) {
    setSessionToken(m[1]);
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      /* ignore */
    }
  }
  return getSessionToken();
}
