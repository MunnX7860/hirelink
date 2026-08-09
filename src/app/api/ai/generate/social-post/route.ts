import { handleRoute } from '@/lib/errors'
import { GenerateSocialPostInput } from '@/features/ai/schemas'
import { generateSocialPostFeature } from '@/features/ai/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** POST /api/ai/generate/social-post — docs/05 §4.7 (≤280 chars + link line). */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()

  const input = GenerateSocialPostInput.parse(await request.json())
  return generateSocialPostFeature(supabase, scope, input)
})
