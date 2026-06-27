/**
 * Light / dark theme toggle.
 *
 * Dark is the default look. Flipping to light sets `data-theme="light"` on
 * <html>, which activates the override block in `index.css`. The choice is
 * persisted in localStorage; the inline script in `index.html` reads it
 * before first paint so deep-linked pages (EC2, Lightsail) inherit the
 * same theme without a flash.
 *
 * State lives in localStorage as the source of truth. The hook keeps a
 * React-friendly mirror and applies the DOM attribute + persistence via a
 * single `useEffect`, so updates are always synchronous and order-safe.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'aws-panel-theme';

function readInitial(): Theme {
  try {
    if (localStorage.getItem(STORAGE_KEY) === 'light') return 'light';
  } catch {
    /* private mode / storage disabled — fall through to default */
  }
  return 'dark';
}

function applyDom(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readInitial);

  // Mirror state → DOM + localStorage on every change. Keeping the side
  // effect here (rather than inside the toggle callback) means it also
  // re-runs after StrictMode's double-mount, which guarantees the DOM
  // attribute and storage stay aligned with React's view of the world.
  useEffect(() => {
    applyDom(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
