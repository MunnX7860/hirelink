import { handleRoute } from '@/lib/errors'
import { lookupInvite, requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ token: string }> }

/**
 * GET /api/invites/:token — docs/05 §4.9: peek for the accept screen (auth required).
 * Unknown/expired/consumed → 410 INVITE_EXPIRED (no existence leak).
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase } = await requireWorkspace()
  const { token } = await ctx.params
  return lookupInvite(supabase, token)
})
