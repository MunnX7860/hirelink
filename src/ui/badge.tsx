import { cn } from '@/lib/utils'

/** Small status badge for integrations/settings. */
export function Badge({
  tone = 'muted',
  children,
  className,
}: {
  tone?: 'success' | 'warning' | 'danger' | 'muted'
  children: React.ReactNode
  className?: string
}) {
  const tones = {
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    danger: 'bg-danger/10 text-danger',
    muted: 'bg-slate-200/60 text-slate-600',
  } as const
  return (
    <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', tones[tone], className)}>
      {children}
    </span>
  )
}
