import { NextResponse } from 'next/server'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { requireWorkspace } from '@/features/orgs/server'
import { getScreeningConfig, saveScreeningConfig } from '@/features/screening/server'
import { SaveScreeningConfigInput } from '@/features/screening/schemas'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/jobs/:id/screening-config — full questionnaire incl. PRIVATE rules
 * (owner surfaces only — 17 §3.4). PUT replaces the questionnaire
 * (ids assigned server-side; history-safe — verdicts are never rewritten here).
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const result = await getScreeningConfig(supabase, scope, id)
  if (!result) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')
  return { job: result.job, ...result.config }
})

export const PUT = handleRoute(async (_ctx, request: Request, ctx: RouteContext) => {
  const { supabase, scope } = await requireWorkspace()
  const { id } = await ctx.params
  const input = SaveScreeningConfigInput.parse(await request.json())
  const config = await saveScreeningConfig(supabase, scope, id, input)
  return NextResponse.json(config)
})
