import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Button — docs/06 §3. Exactly one `primary` per viewportful (docs/06 §1.2).
 * Touch targets ≥ 44px (docs/06 §6). `loading` disables + shows spinner.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover active:bg-brand-hover disabled:bg-brand/50',
  secondary:
    'bg-surface text-ink border border-slate-300 hover:bg-surface-muted disabled:text-slate-400',
  ghost: 'text-ink-secondary hover:bg-slate-100 disabled:text-slate-300',
  danger: 'bg-danger text-white hover:bg-red-700 disabled:bg-danger/50',
}

const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-base', // 44px — minimum comfortable target
  lg: 'h-13 min-h-13 px-5 text-base',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex min-w-11 items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  )
})
