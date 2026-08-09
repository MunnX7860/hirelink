import { handleRoute } from '@/lib/errors'
import { removeMember, requireWorkspace, updateMemberRole } from '@/features/orgs/server'
import { UpdateMemberInput } from '@/features/orgs/schemas'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string; userId: string }> }

/**
 * PATCH  /api/orgs/:id/members/:userId — role change (members.manage; org owner
 *   untouchable; demoting an admin needs the org owner — docs/11 §2).
 * DELETE /api/orgs/:id/members/:userId — remove member (or self-leave for non-owners).
 */
export const PATCH = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id, userId } = await ctx.params
  const input = UpdateMemberInput.parse(await request.json())
  await updateMemberRole(supabase, scope, id, userId, input.role)
  return { ok: true }
})

export const DELETE = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id, userId } = await ctx.params
  await removeMember(supabase, scope, id, userId)
  return new Response(null, { status: 204 })
})
