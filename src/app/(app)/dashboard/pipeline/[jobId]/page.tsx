import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getJob } from '@/features/jobs/server'
import { listApplications } from '@/features/applications/server'
import { listTags } from '@/features/applicants/server'
import { resolveWorkspace } from '@/features/orgs/server'
import {
  PipelineBoard,
  BOARD_COLUMNS,
  type BoardCardData,
} from '@/features/pipeline/pipeline-board'

export const metadata: Metadata = { title: 'Pipeline' }
export const dynamic = 'force-dynamic'

/** Pipeline board — docs/02 §6 + docs/06 §4 `/dashboard/pipeline/[jobId]`. */
export default async function PipelinePage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const job = await getJob(supabase, scope, jobId)
  if (!job) notFound()

  const [applications, tags] = await Promise.all([
    listApplications(supabase, scope, {
      job_id: job.id,
      status: [...BOARD_COLUMNS],
      limit: 100,
    }),
    listTags(supabase, scope),
  ])

  const cards: BoardCardData[] = applications.data.map((item) => ({
    id: item.id,
    status: item.status,
    applicantName: item.applicant.full_name,
    appliedAt: item.applied_at,
    hasResume: item.has_resume,
    resumeFailed: item.resume_failed,
    tags: item.tags,
  }))

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold text-ink">{job.title} — pipeline</h1>
          <p className="text-sm text-ink-secondary">
            <Link href={`/dashboard/jobs/${job.id}`} className="font-medium text-brand">
              ← Job details
            </Link>
          </p>
        </div>
        <span className="text-sm text-ink-secondary">{cards.length} active</span>
      </div>
      <PipelineBoard jobId={job.id} initialCards={cards} tags={tags} />
    </div>
  )
}
