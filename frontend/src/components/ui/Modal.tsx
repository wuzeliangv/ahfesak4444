import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import clsx from 'clsx';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizes = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export function Modal({ open, onClose, title, description, children, size = 'md' }: Props) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onEsc);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        aria-label="Close modal"
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-xl"
      />
      <div
        className={clsx(
          'glass-card relative w-full p-6 animate-[fadeIn_140ms_ease-out]',
          'backdrop-blur-[28px]',
          sizes[size],
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-full border border-[var(--color-border-glass)] bg-white/5 text-[var(--color-fg-muted)] transition-colors hover:bg-white/10 hover:text-[var(--color-fg-primary)]"
        >
          <X size={16} />
        </button>
        {(title || description) && (
          <header className="mb-5 pr-10">
            {title && (
              <h2 className="text-lg font-semibold tracking-tight text-[var(--color-fg-primary)]">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-1 text-sm text-[var(--color-fg-secondary)]">{description}</p>
            )}
          </header>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
