/**
 * Lightweight toast notification store — replaces the panel's many
 * `alert()` calls with stacked non-blocking notifications in the bottom
 * right corner.
 *
 * Design notes:
 *   - Tiny pub-sub instead of pulling in zustand/jotai; the hook just
 *     subscribes to module-level state.
 *   - Auto-dismiss interval depends on `kind`: success vanishes quickly,
 *     errors linger so the user can read multi-line failure summaries.
 *   - Pass `duration: 0` to make a toast sticky until manually dismissed.
 *   - Messages support `\n` line breaks (rendered via `whitespace-pre-line`).
 */

import { useEffect, useState } from 'react';

export type ToastKind = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  kind: ToastKind;
  title?: string;
  message: string;
  /** ms before auto-dismiss; 0 = sticky. */
  duration: number;
}

interface ToastOptions {
  title?: string;
  duration?: number;
}

const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  success: 3000,
  info: 4000,
  warning: 5000,
  error: 8000,
};

const listeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];
let nextId = 1;

function notify() {
  const snapshot = [...toasts];
  for (const l of listeners) l(snapshot);
}

function addToast(kind: ToastKind, message: string, opts: ToastOptions = {}): string {
  const id = `t${nextId++}`;
  const duration = opts.duration ?? DEFAULT_DURATIONS[kind];
  toasts = [...toasts, { id, kind, message, title: opts.title, duration }];
  notify();
  if (duration > 0) {
    setTimeout(() => removeToast(id), duration);
  }
  return id;
}

export function removeToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export function clearToasts(): void {
  toasts = [];
  notify();
}

export const toast = {
  success: (message: string, opts?: ToastOptions) => addToast('success', message, opts),
  error: (message: string, opts?: ToastOptions) => addToast('error', message, opts),
  warning: (message: string, opts?: ToastOptions) => addToast('warning', message, opts),
  info: (message: string, opts?: ToastOptions) => addToast('info', message, opts),
};

/** React hook that re-renders the consumer whenever the toast list changes. */
export function useToasts(): Toast[] {
  const [snapshot, setSnapshot] = useState<Toast[]>(() => [...toasts]);
  useEffect(() => {
    const listener = (s: Toast[]) => setSnapshot(s);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return snapshot;
}
