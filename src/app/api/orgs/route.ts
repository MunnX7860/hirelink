import { handleRoute } from '@/lib/errors'
import { createOrg, getMemberships, requireWorkspace } from '@/features/orgs/server'
import { CreateOrgInput } from '@/features/orgs/schemas'

export const runtime = 'nodejs'

/**
 * GET /api/orgs — docs/05 §4.9: my memberships (soft-deleted orgs excluded).
 * POST /api/orgs — create org; caller becomes owner.
 */
export const GET = handleRoute(async () => {
  const { supabase, user } = await requireWorkspace()
  const memberships = await getMemberships(supabase, user.id)
  return {
    data: memberships.map((m) => ({ org: m.org, role: m.role })),
  }
})

export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, user } = await requireWorkspace()
  const input = CreateOrgInput.parse(await request.json())
  const created = await createOrg(supabase, user.id, input)
  return Response.json(created, { status: 201 })
})
