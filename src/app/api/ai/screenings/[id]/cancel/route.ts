import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { requireWorkspace } from '@/features/orgs/server'
import { cancelScreeningSession } from '@/features/screening/sessions'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/screenings/:id/cancel — docs/05 §4.10: stop an in-flight
 * session. A live Gemini Batch job is cancelled remotely best-effort (D4: the
 * local row never blocks on the provider); unscreened rows stay pending and a
 * later retry revives them. 409 when the session already reached a terminal
 * state; 404 outside scope.
 */
export const POST = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params

  const result = await cancelScreeningSession(supabase, scope, id)
  if (!result) throw new AppError(ErrorCode.NOT_FOUND, 'Screening session not found.')
  return result
})
