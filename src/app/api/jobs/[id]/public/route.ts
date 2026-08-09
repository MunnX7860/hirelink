import { handleRoute, AppError, ErrorCode } from '@/lib/errors'
import { createServiceClient } from '@/lib/supabase/service'
import { getPublicJobBySlug } from '@/features/jobs/server'
import { publicQuestionsFor } from '@/features/screening/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> }

/**
 * GET /api/jobs/:slug/public — docs/05 §4.1 (PUBLIC form config for the apply page).
 * Implementation note: the folder is `[id]` because Next.js requires one param name
 * per dynamic segment; in this PUBLIC route the value is always a job SLUG
 * (the URL contract — docs/05 §4.1 — is unchanged).
 * Non-sensitive columns only; draft/unknown slugs → 404 (no existence leak).
 */
export const GET = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { id: slug } = await ctx.params
  const job = await getPublicJobBySlug(createServiceClient(), slug)
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')
  return {
    title: job.title,
    description: job.description,
    status: job.status,
    form_config: job.form_config,
    // Phase 5 (17 §3.4): SANITIZED — labels/options only, rules never leave the server.
    questions: publicQuestionsFor(job),
  }
})
