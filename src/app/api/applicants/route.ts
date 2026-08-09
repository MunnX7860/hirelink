import { handleRoute } from '@/lib/errors'
import { ListApplicantsQuery } from '@/features/applicants/schemas'
import { listApplicants } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** GET /api/applicants — docs/05 §4.4 talent pool (q? tag_id? cursor pagination), scoped (docs/11 §1). */
export const GET = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const { searchParams } = new URL(request.url)
  const q = ListApplicantsQuery.parse({
    q: searchParams.get('q') ?? undefined,
    tag_id: searchParams.get('tag_id') ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
  })
  return listApplicants(supabase, scope, q)
})
