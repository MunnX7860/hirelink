import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getJob } from '@/features/jobs/server'
import { getScopedIntegration } from '@/lib/integrations/resolve'
import { resolveWorkspace } from '@/features/orgs/server'
import { refForScope } from '@/features/orgs/scope'
import { JobForm } from '@/features/jobs/job-form'

export const metadata: Metadata = { title: 'Edit job' }
export const dynamic = 'force-dynamic'

export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const [job, drive, ai] = await Promise.all([
    getJob(supabase, scope, id),
    getScopedIntegration(supabase, refForScope(scope), 'google_drive'),
    getScopedIntegration(supabase, refForScope(scope), 'ai'),
  ])
  if (!job) notFound()

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-xl font-bold text-ink">Edit job</h1>
      <JobForm
        mode="edit"
        job={job}
        driveConnected={Boolean(drive && drive.row.status === 'active')}
        aiEnabled={Boolean(ai && ai.row.status === 'active')}
      />
    </div>
  )
}
