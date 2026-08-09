import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getJob } from '@/features/jobs/server'
import { resolveWorkspace } from '@/features/orgs/server'
import { getScopedIntegration } from '@/lib/integrations/resolve'
import { refForScope } from '@/features/orgs/scope'
import { getJobScreeningCounters, listScreeningSessions } from '@/features/screening/sessions'
import { ScreeningDashboard } from '@/features/screening/screening-dashboard'

export const metadata: Metadata = { title: 'Screening' }
export const dynamic = 'force-dynamic'

/**
 * Screening dashboard — docs/17 §12 (tab beside Pipeline), docs/06.
 * Server renders counters + append-only session history; the interactive form,
 * polling and result expansion are client-side. AI stays optional: configured
 * key → form; otherwise the visible-but-explained card (docs/10 §6).
 */
export default async function JobScreeningPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const job = await getJob(supabase, scope, id)
  if (!job) notFound()

  const [ai, counters, sessionsResult] = await Promise.all([
    getScopedIntegration(supabase, refForScope(scope), 'ai'),
    getJobScreeningCounters(supabase, scope, id),
    listScreeningSessions(supabase, scope, id),
  ])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 pb-24">
      <div className="min-w-0">
        <p className="text-sm text-ink-secondary">
          <Link href={`/dashboard/jobs/${job.id}`} className="hover:text-brand">
            ← {job.title}
          </Link>
        </p>
        <h1 className="truncate text-xl font-bold text-ink">AI screening</h1>
        <p className="text-sm text-ink-secondary">
          Advisory shortlists with reasons &amp; evidence — you decide everything.
        </p>
      </div>

      <ScreeningDashboard
        jobId={job.id}
        aiConfigured={Boolean(ai && ai.row.status === 'active')}
        counters={
          counters ?? {
            qualified: 0,
            review_required: 0,
            does_not_meet_mandatory: 0,
            unscreened: 0,
            total: 0,
          }
        }
        initialSessions={sessionsResult?.sessions ?? []}
      />
    </div>
  )
}
