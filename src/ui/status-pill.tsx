import { cn } from '@/lib/utils'
import type { ApplicationStatusValue } from '@/features/applications/schemas'

/**
 * StatusPill — docs/06 §2 palette + §3 (uppercase 11px, colored bg/10 + colored text,
 * text always present — never color-only, docs/06 §6).
 */
const TONES: Record<string, string> = {
  new: 'bg-status-new/10 text-status-new',
  reviewing: 'bg-status-reviewing/10 text-sky-700',
  shortlisted: 'bg-status-shortlisted/10 text-status-shortlisted',
  interview: 'bg-status-interview/10 text-amber-700',
  offered: 'bg-status-offered/10 text-teal-700',
  hired: 'bg-status-hired/10 text-status-hired',
  rejected: 'bg-status-rejected/10 text-status-rejected',
  archived: 'bg-status-archived/10 text-status-archived',
  draft: 'bg-slate-200/60 text-slate-600',
  active: 'bg-success/10 text-success',
  closed: 'bg-slate-200/60 text-slate-600',
}

export function StatusPill({
  status,
  className,
}: {
  status: ApplicationStatusValue | 'draft' | 'active' | 'closed'
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide',
        TONES[status] ?? TONES.archived,
        className,
      )}
    >
      {status}
    </span>
  )
}
