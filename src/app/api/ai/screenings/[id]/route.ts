import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { requireWorkspace } from '@/features/orgs/server'
import { getScreeningSession } from '@/features/screening/sessions'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/screenings/:id — docs/05 §4.10: session detail + results grouped
 * for display (17 §7 top-N upper-bound semantics applied in the read model;
 * rows stream incrementally while the session processes).
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params

  const detail = await getScreeningSession(supabase, scope, id)
  if (!detail) throw new AppError(ErrorCode.NOT_FOUND, 'Screening session not found.')
  return detail
})
