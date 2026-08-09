import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Banner — docs/06 §3/§5: integration degradation & persistent notices. */
export function Banner({
  tone = 'warning',
  title,
  children,
  action,
  className,
}: {
  tone?: 'warning' | 'info' | 'danger' | 'success'
  title: string
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const tones = {
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    danger: 'border-red-200 bg-red-50 text-red-900',
    success: 'border-green-200 bg-green-50 text-green-900',
  } as const

  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-1 rounded-[12px] border p-4 sm:flex-row sm:items-center sm:justify-between',
        tones[tone],
        className,
      )}
    >
      <div>
        <p className="text-sm font-semibold">{title}</p>
        {children ? <div className="text-sm opacity-90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
