import Link from 'next/link'
import { Card } from '@/ui/card'
import { StatusPill } from '@/ui/status-pill'
import { relativeTime } from '@/lib/time'
import type { ApplicationListItem } from '@/features/applications/server'

/** Application card — docs/02 §5: name, job, time, contact, status pill, resume flag. */
export function ApplicationCard({ item }: { item: ApplicationListItem }) {
  return (
    <Link
      href={`/dashboard/applications/${item.id}`}
      aria-label={`Application from ${item.applicant.full_name}`}
    >
      <Card className="flex flex-col gap-2 transition-shadow hover:shadow-md active:bg-surface-muted">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold text-ink">{item.applicant.full_name}</p>
            <p className="truncate text-sm text-ink-secondary">{item.job.title}</p>
          </div>
          <StatusPill status={item.status} />
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-ink-secondary">
          <span className="truncate">
            {item.applicant.email}
            {item.applicant.phone ? ` · ${item.applicant.phone}` : ''}
          </span>
          <span className="shrink-0">{relativeTime(item.applied_at)}</span>
        </div>
        {item.resume_failed ? (
          <p className="text-xs font-medium text-warning">
            Resume upload failed — applicant can resubmit
          </p>
        ) : item.has_resume ? (
          <p className="text-xs text-ink-secondary">📄 Resume attached</p>
        ) : null}
      </Card>
    </Link>
  )
}
