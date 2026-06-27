/**
 * Toast container — renders the global toast queue in the bottom-right
 * corner via a portal so it floats above any modal / page chrome.
 *
 * Stacking direction: column-reverse, so the newest toast appears at the
 * bottom and older ones bubble up. This makes the bottom edge act like a
 * "now" anchor — the user's eye stays on the freshest message even as
 * older ones expire.
 */

import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import clsx from 'clsx';
import { removeToast, useToasts, type ToastKind } from '@/lib/toast';

const ICONS: Record<ToastKind, React.ComponentType<{ size?: number; className?: string }>> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const TONES: Record<ToastKind, string> = {
  success: 'border-l-emerald-500/80 text-emerald-300',
  error: 'border-l-[var(--color-status-error)] text-[var(--color-status-error)]',
  warning: 'border-l-[var(--color-status-warn)] text-[var(--color-status-warn)]',
  info: 'border-l-[var(--color-accent-500)] text-[var(--color-accent-300)]',
};

export function ToastContainer() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return createPortal(
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed top-4 right-4 z-[60] flex max-h-[80vh] w-[min(360px,calc(100vw-2rem))] flex-col-reverse gap-2 overflow-hidden"
    >
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            role="status"
            className={clsx(
              'glass-card pointer-events-auto relative flex items-start gap-2.5 border-l-4 p-3 pr-8 !rounded-2xl',
              'animate-[slideInRight_180ms_ease-out]',
              TONES[t.kind],
            )}
          >
            <Icon size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1 text-xs">
              {t.title && (
                <p className="mb-0.5 font-semibold tracking-tight text-[var(--color-fg-primary)]">
                  {t.title}
                </p>
              )}
              <p className="whitespace-pre-line break-words text-[var(--color-fg-secondary)]">
                {t.message}
              </p>
            </div>
            <button
              type="button"
              onClick={() => removeToast(t.id)}
              aria-label="关闭通知"
              className="absolute right-1.5 top-1.5 rounded p-0.5 text-[var(--color-fg-muted)] hover:bg-white/5 hover:text-[var(--color-fg-primary)]"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
