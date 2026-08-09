import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { listApplicants, listTags } from '@/features/applicants/server'
import { resolveWorkspace } from '@/features/orgs/server'
import { ApplicantExplorer } from '@/features/applicants/applicant-explorer'

export const metadata: Metadata = { title: 'People' }
export const dynamic = 'force-dynamic'

/** Talent pool — docs/02 §7 + docs/06 §4 `/dashboard/applicants`. Primary action: search/filter. */
export default async function ApplicantsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)

  const [applicants, tags] = await Promise.all([
    listApplicants(supabase, scope, { limit: 50 }),
    listTags(supabase, scope),
  ])

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink">People</h1>
        <span className="text-sm text-ink-secondary">Your talent pool</span>
      </div>
      <ApplicantExplorer
        initialItems={applicants.data}
        initialCursor={applicants.next_cursor}
        tags={tags}
      />
    </div>
  )
}
