import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { listJobs } from '@/features/jobs/server'
import { resolveWorkspace } from '@/features/orgs/server'
import { Card } from '@/ui/card'
import { StatusPill } from '@/ui/status-pill'
import { EmptyState } from '@/ui/empty-state'
import { IconBriefcase, IconPlus } from '@/ui/icons'
import { env } from '@/lib/env'
import { JobCardActions } from '@/features/jobs/job-card-actions'

export const metadata: Metadata = { title: 'Jobs' }
export const dynamic = 'force-dynamic'

/** Jobs list — docs/06 §4: cards (title, status, counts, copy-link), FAB = New Job. */
export default async function JobsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const { data: jobs } = await listJobs(supabase, scope, { limit: 50 })

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <h1 className="sr-only">Jobs</h1>

      {jobs.length === 0 ? (
        <EmptyState
          icon={<IconBriefcase className="size-6" />}
          title="Create your first hiring link"
          description="Post it on WhatsApp, Instagram, Telegram — anywhere your audience is. Takes under 2 minutes."
          action={
            <Link
              href="/dashboard/jobs/new"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-base font-medium text-white hover:bg-brand-hover"
            >
              <IconPlus className="size-5" /> New job
            </Link>
          }
        />
      ) : (
        jobs.map((job) => (
          <Card key={job.id} className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <Link href={`/dashboard/jobs/${job.id}`} className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-ink hover:text-brand">
                  {job.title}
                </p>
                <p className="text-sm text-ink-secondary">
                  {job.new_count > 0 ? (
                    <span className="font-medium text-brand">{job.new_count} new</span>
                  ) : (
                    'No new'
                  )}{' '}
                  · {job.application_count} total
                </p>
              </Link>
              <div className="flex items-center gap-2">
                <StatusPill status={job.status} />
                <JobCardActions
                  jobId={job.id}
                  applyUrl={`${env.NEXT_PUBLIC_APP_URL}/apply/${job.slug}`}
                />
              </div>
            </div>
          </Card>
        ))
      )}

      {/* FAB — docs/06 §3: context-aware primary create */}
      {jobs.length > 0 ? (
        <Link
          href="/dashboard/jobs/new"
          aria-label="New job"
          className="fixed bottom-24 right-4 z-10 flex size-14 items-center justify-center rounded-full bg-brand text-white shadow-lg hover:bg-brand-hover lg:bottom-8"
        >
          <IconPlus className="size-7" />
        </Link>
      ) : null}
    </div>
  )
}
