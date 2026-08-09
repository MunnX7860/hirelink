import { handleRoute, AppError, ErrorCode } from '@/lib/errors'
import { UpdateJobInput } from '@/features/jobs/schemas'
import { deleteJob, getJob, getJobStats, updateJob } from '@/features/jobs/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** GET /api/jobs/:id — docs/05 §4.1: job + stats.by_status (404 = not found OR not owned). */
export const GET = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const job = await getJob(supabase, scope, id)
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')
  const byStatus = await getJobStats(supabase, job.id)
  return { ...job, stats: { by_status: byStatus } }
})

/** PATCH /api/jobs/:id — docs/05 §4.1: title/description/form_config/status (transition rules enforced). */
export const PATCH = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const job = await getJob(supabase, scope, id)
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')
  const input = UpdateJobInput.parse(await request.json())
  return updateJob(supabase, scope, job, input)
})

/** DELETE /api/jobs/:id — cascades per docs/04 §8. 204. */
export const DELETE = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const job = await getJob(supabase, scope, id)
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')
  await deleteJob(supabase, id)
  return new Response(null, { status: 204 })
})
