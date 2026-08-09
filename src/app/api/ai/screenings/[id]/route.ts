import { after } from 'next/server'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import { requireWorkspace } from '@/features/orgs/server'
import { isLeaseClaimable } from '@/features/screening/session-schemas'
import { getScreeningSession } from '@/features/screening/sessions'
import { processScreeningSession } from '@/features/screening/process'

export const runtime = 'nodejs'
/** after() advance-on-view slice (17 §9.1), same budget as create. */
export const maxDuration = 60

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/screenings/:id — docs/05 §4.10: session detail + results grouped
 * for display (17 §7 top-N upper-bound semantics applied in the read model;
 * rows stream incrementally while the session processes).
 *
 * Advance-on-view (17 §9.1): while the session is active, this same request
 * kicks one processing slice in after() — the dashboard's 3s polling then
 * doubles as the self-healing ticker on hosts without per-minute cron
 * (Hobby). Concurrency-safe: the CAS lease arbitrates every advancer.
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params

  const detail = await getScreeningSession(supabase, scope, id)
  if (!detail) throw new AppError(ErrorCode.NOT_FOUND, 'Screening session not found.')

  if (isLeaseClaimable(detail.session.status, null, Date.now())) {
    after(async () => {
      try {
        await processScreeningSession(supabase, scope, id)
      } catch (err) {
        logger.error('screening advance-on-view failed', { ...errorSummary(err) })
      }
    })
  }

  return detail
})
