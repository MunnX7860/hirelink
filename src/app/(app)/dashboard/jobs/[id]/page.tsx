import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getJob, getJobStats } from '@/features/jobs/server'
import { listApplications } from '@/features/applications/server'
import { getJobScreeningCounters } from '@/features/screening/sessions'
import { Card } from '@/ui/card'
import { StatusPill } from '@/ui/status-pill'
import { ApplicationCard } from '@/features/applications/application-card'
import { JobDetailActions } from '@/features/jobs/job-detail-actions'
import { env } from '@/lib/env'
import { PIPELINE_ORDER } from '@/features/applications/schemas'
import { getScopedIntegration } from '@/lib/integrations/resolve'
import { getMemberships, resolveWorkspace } from '@/features/orgs/server'
import { refForScope } from '@/features/orgs/scope'
import { SocialPostGenerator } from '@/features/ai/social-post-generator'
import { relativeTime } from '@/lib/time'

export const metadata: Metadata = { title: 'Job' }
export const dynamic = 'force-dynamic'

/** Job detail — docs/06 §4: stats strip, share link primary, recent applications. */
export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const job = await getJob(supabase, scope, id)
  if (!job) notFound()

  const [byStatus, recent, ai, memberships, screeningCounters] = await Promise.all([
    getJobStats(supabase, job.id),
    listApplications(supabase, scope, { job_id: job.id, status: undefined, limit: 5 }),
    getScopedIntegration(supabase, refForScope(scope), 'ai'),
    getMemberships(supabase, user.id),
    getJobScreeningCounters(supabase, scope, job.id),
  ])
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
  const applyUrl = `${env.NEXT_PUBLIC_APP_URL}/apply/${job.slug}`

  // Move-to-workspace targets (docs/02 §10.6): creator or source-org admin may
  // move; personal is a target only for the creator (mirrors features/orgs/server.moveJob).
  const isCreator = job.owner_id === user.id
  const canMove = isCreator || (scope.kind === 'org' && scope.role !== 'member')
  const moveTargets = !canMove
    ? null
    : [
        ...(job.organization_id && isCreator ? [{ organizationId: null, label: 'Personal' }] : []),
        ...memberships
          .filter((m) => m.org.id !== job.organization_id)
          .map((m) => ({ organizationId: m.org.id, label: m.org.name })),
      ]

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold text-ink">{job.title}</h1>
          <p className="text-xs text-ink-secondary">Created {relativeTime(job.created_at)}</p>
        </div>
        <StatusPill status={job.status} />
      </div>

      <JobDetailActions job={job} applyUrl={applyUrl} moveTargets={moveTargets} />

      <Card>
        <h2 className="mb-2 text-base font-semibold text-ink">Hiring post</h2>
        <SocialPostGenerator jobId={job.id} aiEnabled={Boolean(ai && ai.row.status === 'active')} />
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Pipeline</h2>
          <Link
            href={`/dashboard/pipeline/${job.id}`}
            className="text-sm font-medium text-brand hover:underline"
          >
            Open board →
          </Link>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {PIPELINE_ORDER.map((s) => (
            <div
              key={s}
              className="flex min-w-20 flex-col items-center rounded-lg bg-surface-muted px-3 py-2"
            >
              <span className="text-lg font-bold text-ink">{byStatus[s] ?? 0}</span>
              <span className="text-[11px] uppercase tracking-wide text-ink-secondary">{s}</span>
            </div>
          ))}
          <div className="flex min-w-20 flex-col items-center rounded-lg bg-surface-muted px-3 py-2">
            <span className="text-lg font-bold text-ink">{total}</span>
            <span className="text-[11px] uppercase tracking-wide text-ink-secondary">total</span>
          </div>
        </div>
      </Card>

      {/* Screening tab beside Pipeline (17 §12) */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">Screening</h2>
          <Link
            href={`/dashboard/jobs/${job.id}/screening`}
            className="text-sm font-medium text-brand hover:underline"
          >
            Open screening →
          </Link>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {(
            [
              ['Qualified', screeningCounters?.qualified ?? 0],
              ['Needs review', screeningCounters?.review_required ?? 0],
              ['DNMC', screeningCounters?.does_not_meet_mandatory ?? 0],
              ['Unscreened', screeningCounters?.unscreened ?? 0],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="flex min-w-20 flex-col items-center rounded-lg bg-surface-muted px-3 py-2"
            >
              <span className="text-lg font-bold text-ink">{value}</span>
              <span className="text-[11px] uppercase tracking-wide text-ink-secondary">
                {label}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">Recent applications</h2>
        <Link href={`/dashboard?job_id=${job.id}`} className="text-sm font-medium text-brand">
          View all
        </Link>
      </div>
      {recent.data.length === 0 ? (
        <Card>
          <p className="py-4 text-center text-sm text-ink-secondary">
            No applications yet — share your hiring link to get started.
          </p>
        </Card>
      ) : (
        recent.data.map((item) => <ApplicationCard key={item.id} item={item} />)
      )}
    </div>
  )
}
