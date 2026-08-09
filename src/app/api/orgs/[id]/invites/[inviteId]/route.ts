import { handleRoute } from '@/lib/errors'
import { requireWorkspace, revokeInvite } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string; inviteId: string }> }

/** DELETE /api/orgs/:id/invites/:inviteId — docs/05 §4.9: revoke a pending invite. */
export const DELETE = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id, inviteId } = await ctx.params
  await revokeInvite(supabase, scope, id, inviteId)
  return new Response(null, { status: 204 })
})
