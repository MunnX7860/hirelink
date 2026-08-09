import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { listApplications } from '@/features/applications/server'
import { listJobs } from '@/features/jobs/server'
import { listTags } from '@/features/applicants/server'
import { resolveWorkspace } from '@/features/orgs/server'
import { ApplicationExplorer } from '@/features/applications/application-explorer'
import { EmptyState } from '@/ui/empty-state'
import { IconInbox, IconPlus } from '@/ui/icons'
import { z } from 'zod'

export const metadata: Metadata = { title: 'Inbox' }
export const dynamic = 'force-dynamic'

const Query = z.object({ job_id: z.string().uuid().optional() })

/**
 * Inbox — docs/02 §5–6: default = `new` across jobs; search/filters/bulk via
 * ApplicationExplorer. With ?job_id= it becomes the all-status view for one job.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const params = Query.parse(await searchParams)
  const jobScoped = Boolean(params.job_id)
  const [{ data: applications, next_cursor }, jobs, tags] = await Promise.all([
    // Job-scoped view includes every status (that's its "View all" semantic).
    jobScoped
      ? listApplications(supabase, scope, { job_id: params.job_id, status: undefined, limit: 50 })
      : listApplications(supabase, scope, { limit: 50 }),
    listJobs(supabase, scope, { limit: 100 }),
    listTags(supabase, scope),
  ])
  const jobOptions = jobs.data.map((j) => ({ id: j.id, title: j.title }))

  if (applications.length === 0 && !jobScoped) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
        <h1 className="text-xl font-bold text-ink">Inbox</h1>
        <EmptyState
          icon={<IconInbox className="size-6" />}
          title="No new applications"
          description="Share a hiring link to start receiving applicants — they'll appear here, newest first."
          action={
            <Link
              href="/dashboard/jobs/new"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-base font-medium text-white hover:bg-brand-hover"
            >
              <IconPlus className="size-5" /> Create a hiring link
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4 pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink">{jobScoped ? 'Applications' : 'Inbox'}</h1>
        {!jobScoped ? (
          <span className="text-sm text-ink-secondary">
            {applications.length === 0 ? '' : `${applications.length} shown`}
          </span>
        ) : null}
      </div>
      <ApplicationExplorer
        initialItems={applications}
        initialCursor={next_cursor}
        jobs={jobOptions}
        tags={tags}
        inboxDefault={!jobScoped}
        fixedJobId={params.job_id}
      />
    </div>
  )
}
