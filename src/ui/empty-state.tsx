import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** EmptyState — docs/06 §5: icon, one line, single CTA that teaches the next step. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
      {icon ? (
        <div className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-ink-secondary">
          {icon}
        </div>
      ) : null}
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {description ? <p className="max-w-sm text-sm text-ink-secondary">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
