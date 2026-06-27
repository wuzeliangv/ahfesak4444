import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leadingIcon?: ReactNode;
  trailingSlot?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, hint, error, leadingIcon, trailingSlot, className, id, ...rest },
  ref,
) {
  const inputId = id ?? rest.name;
  return (
    <label htmlFor={inputId} className="block">
      {label && (
        <span className="mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-fg-secondary)] uppercase">
          {label}
        </span>
      )}
      <span
        className={clsx(
          'glass-input flex items-center gap-2 px-3 h-10',
          error && 'border-[var(--color-status-error)]/60',
          className,
        )}
      >
        {leadingIcon && (
          <span className="text-[var(--color-fg-muted)]">{leadingIcon}</span>
        )}
        <input
          ref={ref}
          id={inputId}
          className="flex-1 bg-transparent border-0 outline-none text-sm placeholder:text-[var(--color-fg-muted)]"
          {...rest}
        />
        {trailingSlot}
      </span>
      {(error || hint) && (
        <span
          className={clsx(
            'mt-1.5 block text-xs',
            error ? 'text-[var(--color-status-error)]' : 'text-[var(--color-fg-muted)]',
          )}
        >
          {error ?? hint}
        </span>
      )}
    </label>
  );
});
