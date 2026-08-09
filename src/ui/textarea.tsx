import { forwardRef, useId, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/** Textarea with label / hint / error — docs/06 §3 (mirrors Input). */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string | undefined
  hint?: string | undefined
  error?: string | undefined
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, id, className, ...props },
  ref,
) {
  const autoId = useId()
  const inputId = id ?? autoId
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
      ) : null}
      <textarea
        ref={ref}
        id={inputId}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className={cn(
          'min-h-28 w-full rounded-lg border bg-surface px-3 py-2.5 text-base text-ink placeholder:text-slate-400',
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
