import { NextResponse } from 'next/server'
import { handleRoute } from '@/lib/errors'
import { acceptInvite, requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ token: string }> }

/**
 * POST /api/invites/:token/accept — docs/05 §4.9. Atomic RPC (migration 0006):
 * email match, seat cap, idempotent membership. 403 wrong account · 402 seats · 410 expired.
 */
export const POST = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { token } = await ctx.params
  const result = await acceptInvite(supabase, scope, token)
  return NextResponse.json(result, { status: result.already_member ? 200 : 201 })
})
