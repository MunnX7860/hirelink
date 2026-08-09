import { handleRoute } from '@/lib/errors'
import { GenerateJobDescriptionInput } from '@/features/ai/schemas'
import { generateJobDescriptionFeature } from '@/features/ai/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** POST /api/ai/generate/job-description — docs/05 §4.7 (explicit action, human-in-loop). */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const input = GenerateJobDescriptionInput.parse(await request.json())
  return generateJobDescriptionFeature(supabase, scope, input)
})
