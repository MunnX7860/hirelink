import { handleRoute } from '@/lib/errors'
import { createInvite, getOrgDetail, requireWorkspace } from '@/features/orgs/server'
import { CreateInviteInput } from '@/features/orgs/schemas'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET  /api/orgs/:id/invites — pending invites (members.manage; empty list for others).
 * POST /api/orgs/:id/invites — create invite (hashed token; 7d expiry; seats cap → 402;
 *   invite email best-effort; join_url returned for manual sharing).
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const detail = await getOrgDetail(supabase, scope, id)
  return { data: detail.pending_invites }
})

export const POST = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const input = CreateInviteInput.parse(await request.json())
  const result = await createInvite(supabase, scope, id, input)
  return Response.json(result, { status: 201 })
})
