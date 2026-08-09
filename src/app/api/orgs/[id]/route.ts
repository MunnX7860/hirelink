import { handleRoute } from '@/lib/errors'
import { deleteOrg, getOrgDetail, requireWorkspace, updateOrg } from '@/features/orgs/server'
import { UpdateOrgInput } from '@/features/orgs/schemas'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET/PATCH/DELETE /api/orgs/:id — docs/05 §4.9. Member-only (404 otherwise);
 * PATCH name = owner/admin, brand = org owner + non-free plan; DELETE = org owner
 * soft-delete (7-day grace, restore via POST /api/orgs/:id/restore).
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  return getOrgDetail(supabase, scope, id)
})

export const PATCH = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const input = UpdateOrgInput.parse(await request.json())
  return updateOrg(supabase, scope, id, input)
})

export const DELETE = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  await deleteOrg(supabase, scope, id)
  return new Response(null, { status: 204 })
})
