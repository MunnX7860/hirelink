import { handleRoute } from '@/lib/errors'
import { ListApplicationsQuery } from '@/features/applications/schemas'
import { bulkUpdateApplications, listApplications } from '@/features/applications/server'
import { BulkUpdateApplicationsInput } from '@/features/applicants/schemas'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** GET /api/applications — docs/05 §4.3 (default = inbox: status=new, newest first). */
export const GET = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()
  const { searchParams } = new URL(request.url)
  const q = ListApplicationsQuery.parse({
    job_id: searchParams.get('job_id') ?? undefined,
    status: searchParams.get('status') ?? undefined,
    q: searchParams.get('q') ?? undefined,
    tag_id: searchParams.get('tag_id') ?? undefined,
    date_from: searchParams.get('date_from') ?? undefined,
    date_to: searchParams.get('date_to') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
  })
  return listApplications(supabase, scope, q)
})

/** PATCH /api/applications — docs/05 §4.3 bulk: set_status | archive | add_tag (≤100 ids). */
export const PATCH = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope, user } = await requireWorkspace()
  const input = BulkUpdateApplicationsInput.parse(await request.json())
  return bulkUpdateApplications(supabase, scope, input, user.id)
})
