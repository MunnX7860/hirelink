import { handleRoute } from '@/lib/errors'
import { ListTimelineQuery } from '@/features/applicants/schemas'
import { listTimeline } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** GET /api/timeline — docs/05 §4.8 scoped activity feed (docs/11 §1; cursor pagination). */
export const GET = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const { searchParams } = new URL(request.url)
  const q = ListTimelineQuery.parse({
    applicant_id: searchParams.get('applicant_id') ?? undefined,
    application_id: searchParams.get('application_id') ?? undefined,
    type: searchParams.get('type') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
  })
  return listTimeline(supabase, scope, q)
})
