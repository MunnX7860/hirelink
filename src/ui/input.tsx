import { forwardRef, useId, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Input with label / hint / error slots — docs/06 §3.
 * Label is mandatory in spirit: pass `label` (docs/06 §6 — no placeholder-as-label).
 */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string | undefined
  /** Visually hide the label (keeps it for screen readers — docs/06 §6). */
  hideLabel?: boolean | undefined
  hint?: string | undefined
  error?: string | undefined
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hideLabel, hint, error, id, className, ...props },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={inputId} className={hideLabel ? 'sr-only' : 'text-sm font-medium text-ink'}>
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className={cn(
          'h-11 w-full rounded-lg border bg-surface px-3 text-base text-ink placeholder:text-slate-400',
          error ? 'border-danger' : 'border-slate-300 focus:border-brand',
          className,
        )}
        {...props}
      />
      {error ? (
        <p id={`${inputId}-error`} aria-live="polite" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="text-sm text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  )
})
