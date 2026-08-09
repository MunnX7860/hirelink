import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getApplicationDetail } from '@/features/applications/server'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { StatusPill } from '@/ui/status-pill'
import { Button } from '@/ui/button'
import { TimelineList } from '@/features/applications/timeline-list'
import { PipelineStepper } from '@/features/applications/pipeline-stepper'
import { TagEditor } from '@/features/applicants/tag-editor'
import { NotesSection } from '@/features/applicants/notes-section'
import { ApplicationDangerZone } from '@/features/applications/application-danger-zone'
import { AiPanel } from '@/features/ai/ai-panel'
import { AnswersCard } from '@/features/screening/answers-card'
import { listAnswersForApplication } from '@/features/screening/server'
import { getScopedIntegration } from '@/lib/integrations/resolve'
import { resolveWorkspace } from '@/features/orgs/server'
import { refForScope } from '@/features/orgs/scope'
import { relativeTime } from '@/lib/time'
import { RESUME_MIME_LABELS } from '@/features/applications/constants'

export const metadata: Metadata = { title: 'Application' }
export const dynamic = 'force-dynamic'

/** Application detail — docs/02 §5, docs/06 §4. Primary action = Advance (bottom bar). */
export default async function ApplicationDetailPage({
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

  const detail = await getApplicationDetail(supabase, scope, id)
  if (!detail) notFound()

  const [ai, answersResult] = await Promise.all([
    getScopedIntegration(supabase, refForScope(scope), 'ai'),
    listAnswersForApplication(supabase, scope, detail.id),
  ])
  const aiEnabled = ai?.row.status === 'active'

  const resume = detail.resumes.find((r) => r.upload_status === 'uploaded')
  const failedResume = detail.resumes.find((r) => r.upload_status === 'failed')

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 pb-28">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold text-ink">
            <Link
              href={`/dashboard/applicants/${detail.applicant.id}`}
              className="hover:text-brand"
            >
              {detail.applicant.full_name}
            </Link>
          </h1>
          <p className="text-sm text-ink-secondary">
            for{' '}
            <Link href={`/dashboard/jobs/${detail.job.id}`} className="font-medium text-brand">
              {detail.job.title}
            </Link>{' '}
            · applied {relativeTime(detail.applied_at)}
          </p>
        </div>
        <StatusPill status={detail.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contact</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-2 text-sm">
          <a href={`mailto:${detail.applicant.email}`} className="break-all font-medium text-brand">
            {detail.applicant.email}
          </a>
          {detail.applicant.phone ? (
            <a href={`tel:${detail.applicant.phone}`} className="font-medium text-brand">
              {detail.applicant.phone}
            </a>
          ) : (
            <span className="text-ink-secondary">No phone</span>
          )}
        </div>
      </Card>

      {detail.cover_note ? (
        <Card>
          <CardHeader>
            <CardTitle>Cover note</CardTitle>
          </CardHeader>
          <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{detail.cover_note}</p>
        </Card>
      ) : null}

      <AnswersCard
        answers={answersResult?.data ?? []}
        screeningStatus={answersResult?.screening_status ?? detail.screening_status ?? null}
      />

      <Card>
        <CardHeader>
          <CardTitle>Resume</CardTitle>
        </CardHeader>
        {resume ? (
          <div className="flex flex-col gap-3">
            <p className="truncate text-sm text-ink-secondary">
              {resume.original_filename} · {RESUME_MIME_LABELS[resume.mime_type] ?? 'File'} ·{' '}
              {(resume.size_bytes / 1_048_576).toFixed(1)} MB · stored in your Google Drive
            </p>
            <a
              href={`/api/applications/${detail.id}/resume`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="secondary" className="w-full sm:w-auto">
                View resume ↗
              </Button>
            </a>
          </div>
        ) : failedResume ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-warning">Resume upload failed</p>
            <p className="text-sm text-ink-secondary">
              The application was saved but the file couldn’t reach Google Drive. Check your Drive
              connection in Settings, then ask the applicant to resubmit.
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-secondary">No resume attached.</p>
        )}
      </Card>

      {aiEnabled ? (
        <AiPanel
          applicantId={detail.applicant.id}
          resumeId={resume?.id ?? null}
          initialSummary={detail.ai_summary}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Tags</CardTitle>
        </CardHeader>
        <TagEditor applicantId={detail.applicant.id} initialTags={detail.tags} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <NotesSection
          applicantId={detail.applicant.id}
          applicationId={detail.id}
          notes={detail.notes}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <TimelineList events={detail.timeline} />
      </Card>

      <ApplicationDangerZone applicationId={detail.id} />

      <PipelineStepper
        applicationId={detail.id}
        status={detail.status}
        timeline={detail.timeline}
      />
    </div>
  )
}
