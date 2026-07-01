import { Children, isValidElement, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

type Variant = 'primary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3.5 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
};

const variants: Record<Variant, string> = {
  primary:
    'text-white bg-[var(--color-accent-500)] bg-[linear-gradient(180deg,oklch(1_0_0/0.18),transparent_60%)] ' +
    'hover:bg-[var(--color-accent-600)] active:translate-y-[1px] ' +
    'shadow-[inset_0_1px_0_oklch(1_0_0/0.30),0_6px_18px_-6px_oklch(0.62_0.18_255/0.65)]',
  ghost:
    'text-[var(--color-fg-primary)] bg-white/8 backdrop-blur-md border border-[var(--color-border-glass)] ' +
    'hover:bg-white/14 active:translate-y-[1px] shadow-[inset_0_1px_0_oklch(1_0_0/0.10)]',
  outline:
    'bg-transparent text-[var(--color-fg-secondary)] border border-[var(--color-border-glass)] ' +
    'hover:text-[var(--color-fg-primary)] hover:border-white/30 hover:bg-white/5',
  danger:
    'text-[var(--color-status-error)] bg-[var(--color-status-error)]/15 backdrop-blur-md ' +
    'border border-[var(--color-status-error)]/30 hover:bg-[var(--color-status-error)]/25 active:translate-y-[1px]',
};

/**
 * Detect whether `children` contains any React element (i.e. an icon
 * component like a lucide `<RefreshCcw/>`). Text-only buttons pass plain
 * strings, which return false here — and they're the only callers that
 * still need the fallback spinner.
 */
function hasIconChild(children: ReactNode): boolean {
  return Children.toArray(children).some((c) => isValidElement(c));
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  disabled,
  leadingIcon,
  trailingIcon,
  className,
  children,
  ...rest
}: Props) {
  // If any icon is present (leadingIcon or an icon component in children),
  // the loading feedback comes from the liquidFill CSS animation that's
  // wired up via `data-loading`. Pure-text buttons fall back to a spinner.
  const iconExists = !!leadingIcon || hasIconChild(children);
  const showSpinner = loading && !iconExists;

  return (
    <button
      data-loading={loading ? 'true' : undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap shrink-0',
        'transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-500)]/60',
        sizes[size],
        variants[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {showSpinner ? (
        <span
          aria-hidden
          className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      ) : (
        leadingIcon
      )}
      {children}
      {!loading && trailingIcon}
    </button>
  );
}
