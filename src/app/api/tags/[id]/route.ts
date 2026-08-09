import { handleRoute } from '@/lib/errors'
import { deleteTag } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** DELETE /api/tags/:id — docs/05 §4.5 (cascades applicant_tags). */
export const DELETE = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()

  const { id } = await ctx.params
  await deleteTag(supabase, scope, id)
})
