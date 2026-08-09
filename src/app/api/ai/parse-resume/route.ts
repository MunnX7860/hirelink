import { handleRoute } from '@/lib/errors'
import { ParseResumeInput } from '@/features/ai/schemas'
import { parseResumeFeature } from '@/features/ai/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** POST /api/ai/parse-resume — docs/05 §4.7, docs/10 §3–4 (cached on resumes.ai_parsed). */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const input = ParseResumeInput.parse(await request.json())
  return parseResumeFeature(supabase, scope, input.resume_id)
})
