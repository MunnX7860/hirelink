import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { UpdateApplicantInput } from '@/features/applicants/schemas'
import { getApplicantDetail, updateApplicant } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/** GET /api/applicants/:id — docs/05 §4.4 profile + applications + notes + timeline. */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const detail = await getApplicantDetail(supabase, scope, id)
  if (!detail) throw new AppError(ErrorCode.NOT_FOUND, 'Applicant not found.')
  return detail
})

/** PATCH /api/applicants/:id — docs/05 §4.4 (phone; null clears). */
export const PATCH = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const input = UpdateApplicantInput.parse(await request.json())
  return updateApplicant(supabase, scope, id, input)
})
