import { handleRoute } from '@/lib/errors'
import { moveJob, requireWorkspace } from '@/features/orgs/server'
import { MoveJobInput } from '@/features/orgs/schemas'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * POST /api/jobs/:id/move — docs/05 §4.1: move a job personal⇄org (creator or
 * source-org admin; target plan checked). 404 when the job is outside the current scope.
 */
export const POST = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope, user } = await requireWorkspace()
  const { id } = await ctx.params
  const input = MoveJobInput.parse(await request.json())
  return moveJob(supabase, scope, user.id, id, input.organization_id)
})
