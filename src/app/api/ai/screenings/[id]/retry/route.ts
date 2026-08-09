import { after } from 'next/server'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import { requireWorkspace } from '@/features/orgs/server'
import { retryScreeningSession } from '@/features/screening/sessions'
import { processScreeningSession } from '@/features/screening/process'

export const runtime = 'nodejs'
/** after() processing slice (17 §9.1), same as create. */
export const maxDuration = 60

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/screenings/:id/retry — docs/05 §4.10: re-queue failed rows
 * individually and revive a terminal session (17 §9.3 — "7 of 500 fail? retry
 * the 7", never the whole run). 202 when work was re-queued (processing kicks
 * off in after()); a plain 200 {requeued:0,resumed:0} no-op when nothing is
 * left to redo. 409 while the session is still running; 404 outside scope.
 */
export const POST = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params

  const outcome = await retryScreeningSession(supabase, scope, id)
  if (!outcome) throw new AppError(ErrorCode.NOT_FOUND, 'Screening session not found.')

  if (outcome.requeued + outcome.resumed === 0) {
    return outcome // nothing to redo — honest no-op
  }

  after(async () => {
    try {
      await processScreeningSession(supabase, scope, id)
    } catch (err) {
      logger.error('screening retry-kickoff failed', { ...errorSummary(err) })
    }
  })

  return Response.json(outcome, { status: 202 })
})
