import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getApplicantDetail } from '@/features/applicants/server'
import { resolveWorkspace } from '@/features/orgs/server'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { StatusPill } from '@/ui/status-pill'
import { TimelineList } from '@/features/applications/timeline-list'
import { TagEditor } from '@/features/applicants/tag-editor'
import { NotesSection } from '@/features/applicants/notes-section'
import { PhoneEditor } from '@/features/applicants/phone-editor'
import { relativeTime } from '@/lib/time'
import type { ApplicationStatusValue } from '@/features/applications/schemas'

export const metadata: Metadata = { title: 'Applicant' }
export const dynamic = 'force-dynamic'

/** Applicant profile — docs/02 §7 + docs/06 §4. Primary action: Add note. */
export default async function ApplicantProfilePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const detail = await getApplicantDetail(supabase, scope, id)
  if (!detail) notFound()

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 pb-24">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-bold text-ink">{detail.full_name}</h1>
        <p className="text-sm text-ink-secondary">
          In your pool since {relativeTime(detail.created_at)} · via {detail.source}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contact</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-2 text-sm">
          <a href={`mailto:${detail.email}`} className="break-all font-medium text-brand">
            {detail.email}
          </a>
          <PhoneEditor applicantId={detail.id} phone={detail.phone} />
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tags</CardTitle>
        </CardHeader>
        <TagEditor applicantId={detail.id} initialTags={detail.tags} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Applications ({detail.applications.length})</CardTitle>
        </CardHeader>
        {detail.applications.length === 0 ? (
          <p className="text-sm text-ink-secondary">No applications.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.applications.map((app) => (
              <li key={app.id}>
                <Link
                  href={`/dashboard/applications/${app.id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 hover:border-brand"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{app.job.title}</p>
                    <p className="text-xs text-ink-secondary">{relativeTime(app.applied_at)}</p>
                  </div>
                  <StatusPill status={app.status as ApplicationStatusValue} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <NotesSection applicantId={detail.id} notes={detail.notes} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <TimelineList events={detail.timeline} />
      </Card>
    </div>
  )
}
