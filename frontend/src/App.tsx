/**
 * App shell. Provides the QueryClient + router, mounts the vault gate, and
 * routes the unlocked dashboard to the dashboard or a per-account page.
 *
 * Routes:
 *   /                            — account dashboard
 *   /lambda                      — multi-account/region Lambda worker deployer
 *   /account/:id/ec2             — EC2 management for one account
 *   /account/:id/lightsail       — Lightsail management for one account
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Homepage } from './components/Homepage';
import { ToastContainer } from './components/ui/Toast';
import { AccountListPage } from './pages/AccountListPage';
import { Ec2Page } from './pages/Ec2Page';
import { LightsailPage } from './pages/LightsailPage';
import { LambdaDeployPage } from './pages/LambdaDeployPage';
import { ensureEndpointsLoaded } from './lib/endpoints';
import { consumeUrlToken, clearSessionToken } from './lib/session';
import { checkSession } from './lib/deployer';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Personal panel — no need to refetch on tab focus / reconnect by default.
      refetchOnWindowFocus: false,
      retry: (failureCount, err) => {
        // Don't retry InvalidCredentials / Unauthorized — those won't get better.
        const code = (err as { code?: string }).code;
        if (code === 'InvalidCredentials' || code === 'Unauthorized') return false;
        return failureCount < 2;
      },
    },
  },
});

export function App() {
  // Capture a token from the URL hash (if any) and decide initial access.
  const [authed, setAuthed] = useState<boolean>(() => !!consumeUrlToken());

  // Validate the session against the daemon. Lenient: only a definitive
  // 401 (expired/revoked) kicks back to the homepage; network blips don't.
  useEffect(() => {
    if (!authed) return;
    ensureEndpointsLoaded();
    checkSession().then((s) => {
      if (s === 'invalid') {
        clearSessionToken();
        setAuthed(false);
      }
    });
  }, [authed]);

  // A /login link opened in the same tab arrives as a hash change.
  useEffect(() => {
    const onHash = () => {
      if (consumeUrlToken()) setAuthed(true);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!authed) {
    return (
      <QueryClientProvider client={queryClient}>
        <Homepage />
        <ToastContainer />
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<AccountListPage />} />
          <Route path="/lambda" element={<LambdaDeployPage />} />
          <Route path="/account/:id/ec2" element={<Ec2Page />} />
          <Route path="/account/:id/lightsail" element={<LightsailPage />} />
        </Routes>
      </BrowserRouter>
      <ToastContainer />
    </QueryClientProvider>
  );
}
