import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { requireWorkspace } from '@/features/orgs/server'
import { listAnswersForApplication } from '@/features/screening/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/applications/:id/answers — docs/05 §4.10: questionnaire answers +
 * screening verdict for the application detail card (scope-verified via the
 * parent job; out-of-workspace ids → 404, no existence leak).
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const result = await listAnswersForApplication(supabase, scope, id)
  if (!result) throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')
  return result
})
