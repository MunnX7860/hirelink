import { handleRoute } from '@/lib/errors'
import { SummarizeApplicantInput } from '@/features/ai/schemas'
import { summarizeApplicantFeature } from '@/features/ai/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** POST /api/ai/summarize-applicant — docs/05 §4.7, docs/10 §3 (cache applicants.ai_summary). */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const input = SummarizeApplicantInput.parse(await request.json())
  return summarizeApplicantFeature(supabase, scope, input)
})
