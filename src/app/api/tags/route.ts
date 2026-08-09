import { handleRoute } from '@/lib/errors'
import { CreateTagInput } from '@/features/applicants/schemas'
import { createTag, listTags } from '@/features/applicants/server'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/** GET /api/tags — docs/05 §4.5 (workspace tags, α-order — docs/11 §1). */
export const GET = handleRoute(async () => {
  const { supabase, scope } = await requireWorkspace()
  return listTags(supabase, scope)
})

/** POST /api/tags — docs/05 §4.5 (409 on duplicate name). */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()
  const input = CreateTagInput.parse(await request.json())
  return createTag(supabase, scope, input)
})
