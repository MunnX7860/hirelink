import { forwardRef, useId, type SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Select with label / hint / error slots — docs/06 §3. Native `<select>` under the
 * hood (mobile picker UX, zero JS cost) with the shared class authority so features
 * never hand-roll their own select styling.
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string | undefined
  /** Visually hide the label (keeps it for screen readers — docs/06 §6). */
  hideLabel?: boolean | undefined
  hint?: string | undefined
  error?: string | undefined
  /** Override the label's classes (e.g. compact inline filter grids). */
  labelClassName?: string | undefined
  /** Override the outer wrapper's classes (default `flex flex-col gap-1.5`). */
  wrapperClassName?: string | undefined
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hideLabel,
    hint,
    error,
    id,
    className,
    labelClassName,
    wrapperClassName,
    children,
    ...props
  },
  ref,
) {
  const autoId = useId()
  const selectId = id ?? autoId
  const describedBy = error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined

  return (
    <div className={wrapperClassName ?? 'flex flex-col gap-1.5'}>
      {label ? (
        <label
          htmlFor={selectId}
          className={hideLabel ? 'sr-only' : (labelClassName ?? 'text-sm font-medium text-ink')}
        >
          {label}
        </label>
      ) : null}
      <select
        ref={ref}
        id={selectId}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className={cn(
          'h-11 w-full rounded-lg border bg-surface px-3 text-base text-ink',
          error ? 'border-danger' : 'border-slate-300 focus:border-brand',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {error ? (
        <p id={`${selectId}-error`} aria-live="polite" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${selectId}-hint`} className="text-sm text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  )
})
