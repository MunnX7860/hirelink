import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { JobForm } from '@/features/jobs/job-form'
import { getScopedIntegration } from '@/lib/integrations/resolve'
import { resolveWorkspace } from '@/features/orgs/server'
import { refForScope } from '@/features/orgs/scope'

export const metadata: Metadata = { title: 'New job' }
export const dynamic = 'force-dynamic'

/** New job — docs/02 §2. Drive-connection warning when resumes are required (docs/02 §2 ⚠️). */
export default async function NewJobPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const [drive, ai] = await Promise.all([
    getScopedIntegration(supabase, refForScope(scope), 'google_drive'),
    getScopedIntegration(supabase, refForScope(scope), 'ai'),
  ])
  const driveConnected = Boolean(drive && drive.row.status === 'active')

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-xl font-bold text-ink">New job</h1>
      <JobForm
        mode="create"
        driveConnected={driveConnected}
        aiEnabled={Boolean(ai && ai.row.status === 'active')}
      />
    </div>
  )
}
