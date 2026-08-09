import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Toast (presentational) — docs/06 §3: top-center on mobile, auto-dismiss 4s,
 * optional Undo action slot. Interactive queue (max 2, one per action) ships with
 * the first interactive feature (Phase 1) per docs/06 §7.
 */
export function Toast({
  tone = 'info',
  children,
  action,
  className,
}: {
  tone?: 'info' | 'success' | 'danger'
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  const tones = {
    info: 'bg-ink text-white',
    success: 'bg-success text-white',
    danger: 'bg-danger text-white',
  } as const

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-auto flex items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-lg',
        tones[tone],
        className,
      )}
    >
      <div className="flex-1">{children}</div>
      {action}
    </div>
  )
}
