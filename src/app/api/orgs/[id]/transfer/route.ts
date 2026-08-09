import { handleRoute } from '@/lib/errors'
import { requireWorkspace, transferOrg } from '@/features/orgs/server'
import { TransferOrgInput } from '@/features/orgs/schemas'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** POST /api/orgs/:id/transfer — docs/05 §4.9 (org owner only; target must be a member). */
export const POST = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const input = TransferOrgInput.parse(await request.json())
  await transferOrg(supabase, scope, id, input.user_id)
  return { ok: true }
})
