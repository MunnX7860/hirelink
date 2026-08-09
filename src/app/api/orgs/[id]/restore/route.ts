import { handleRoute } from '@/lib/errors'
import { requireWorkspace, restoreOrg } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** POST /api/orgs/:id/restore — docs/05 §4.9: clear deleted_at inside the grace window. */
export const POST = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const org = await restoreOrg(supabase, scope, id)
  return org
})
