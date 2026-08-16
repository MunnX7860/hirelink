import { relativeTime } from '@/lib/time'
import type { TimelineEventRow } from '@/features/applications/schemas'

/**
 * Timeline — docs/02 §5 read-only feed (core subset; notes composer is Phase 2).
 */
const LABELS: Record<string, string> = {
  application_created: 'Applied',
  applicant_created: 'Added to talent pool',
  status_changed: 'Status changed',
  resume_uploaded: 'Resume stored in Drive',
  resume_failed: 'Resume upload failed',
  email_sent: 'Confirmation email sent',
  email_failed: 'Confirmation email failed',
  telegram_sent: 'Telegram alert sent',
  telegram_failed: 'Telegram alert failed',
  ai_summary_generated: 'AI summary generated',
  note_added: 'Note added',
  tag_added: 'Tag added',
  tag_removed: 'Tag removed',
}

function describe(event: Pick<TimelineEventRow, 'type' | 'payload'>): string {
  if (event.type === 'status_changed') {
    const p = event.payload as { from?: string; to?: string }
    return `Status changed: ${p.from ?? '?'} → ${p.to ?? '?'}`
  }
  if (event.type === 'email_sent' && (event.payload as { simulated?: boolean }).simulated) {
    // Says what actually happened. "(dev mode)" read like a deliberate setting,
    // when the real cause is that no email transport is configured — which is
    // just as possible in production as locally.
    return 'Confirmation email not sent — email is not set up yet'
  }
  if (event.type === 'email_skipped') {
    // Why it was skipped matters here: this is a deliberate policy outcome
    // (docs/09 §2), not a failure, and the owner may want to follow up manually.
    const reason = (event.payload as { reason?: string }).reason
    return reason === 'review_required'
      ? 'Confirmation email not sent — needs review'
      : 'Confirmation email not sent — did not meet requirements'
  }
  return LABELS[event.type] ?? event.type
}

export function TimelineList({ events }: { events: TimelineEventRow[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-ink-secondary">No activity yet.</p>
  }
  return (
    <ol className="flex flex-col gap-0">
      {events.map((event, i) => (
        <li key={event.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className="mt-1 size-2 rounded-full bg-brand" aria-hidden />
            {i < events.length - 1 ? (
              <span className="w-px flex-1 bg-slate-200" aria-hidden />
            ) : null}
          </div>
          <div className="pb-4">
            <p className="text-sm text-ink">{describe(event)}</p>
            <p className="text-xs text-ink-secondary">{relativeTime(event.created_at)}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}
