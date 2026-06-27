// Pre-paint theme bootstrap. Runs synchronously before main.tsx so the
// page renders with the saved theme already applied, avoiding a flash
// from default-dark to saved-light.
//
// Lives in /public (served at /theme-init.js) instead of inline because
// our CSP is `script-src 'self'` — inline scripts would be blocked.
//
// Mirror of the logic in `hooks/useTheme.ts`: only "light" sets an
// attribute; "dark" is the default (no attribute).
try {
  if (localStorage.getItem('aws-panel-theme') === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }
} catch (e) {
  /* private mode / storage disabled — non-fatal */
}
