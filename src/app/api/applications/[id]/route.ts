import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { UpdateApplicationInput } from '@/features/applications/schemas'
import {
  deleteApplication,
  getApplicationDetail,
  updateApplicationStatus,
} from '@/features/applications/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** GET /api/applications/:id — docs/05 §4.3 full detail (404 = missing or not owned). */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const detail = await getApplicationDetail(supabase, scope, id)
  if (!detail) throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')
  return detail
})

/** PATCH /api/applications/:id — docs/05 §4.3 status change (journaled). */
export const PATCH = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope, user } = await requireWorkspace()
  const { id } = await ctx.params
  const input = UpdateApplicationInput.parse(await request.json())
  return updateApplicationStatus(supabase, scope, id, input.status, user.id)
})

/** DELETE /api/applications/:id — docs/05 §4.3 + docs/07 §7 (Drive files are kept). */
export const DELETE = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope, user } = await requireWorkspace()
  const { id } = await ctx.params
  return deleteApplication(supabase, scope, id, user.id)
})
