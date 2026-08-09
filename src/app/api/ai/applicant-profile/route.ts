import { handleRoute } from '@/lib/errors'
import { ApplicantProfileInput } from '@/features/ai/schemas'
import { applicantProfileFeature } from '@/features/ai/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/**
 * POST /api/ai/applicant-profile — docs/05 §4.10, docs/17 §6.
 * Staleness-driven build/refresh of the parse-v2 profile cache: a fresh
 * profile short-circuits with cached:true and NO model call; otherwise one
 * Gemini pass over the latest resume (zod-enforced, single retry).
 */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const input = ApplicantProfileInput.parse(await request.json())
  return applicantProfileFeature(supabase, scope, input)
})
