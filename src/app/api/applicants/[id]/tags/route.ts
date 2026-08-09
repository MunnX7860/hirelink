import { handleRoute } from '@/lib/errors'
import { ReplaceTagsInput } from '@/features/applicants/schemas'
import { replaceApplicantTags } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** PUT /api/applicants/:id/tags — docs/05 §4.5 replace set (journaled tag_added/removed). */
export const PUT = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope, user } = await requireWorkspace()

  const { id } = await ctx.params
  const input = ReplaceTagsInput.parse(await request.json())
  return replaceApplicantTags(supabase, scope, id, input.tag_ids, user.id)
})
