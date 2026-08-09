import { NextResponse } from 'next/server'
import { handleRoute } from '@/lib/errors'
import { requireWorkspace } from '@/features/orgs/server'
import { recomputeScreening } from '@/features/screening/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/jobs/:id/screening-recompute — docs/17 §4.4: re-run the deterministic
 * engine over the job's non-terminal applications after questionnaire edits.
 * Synchronous (pure function, DB-bound); changed verdicts are journaled.
 */
export const POST = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const result = await recomputeScreening(supabase, scope, id)
  return NextResponse.json(result)
})
