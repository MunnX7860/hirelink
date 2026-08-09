import { handleRoute } from '@/lib/errors'
import {
  getMembership,
  resolveWorkspace,
  requireWorkspace,
  switchWorkspace,
} from '@/features/orgs/server'
import { SwitchWorkspaceInput } from '@/features/orgs/schemas'

export const runtime = 'nodejs'

/**
 * GET /api/orgs/current — docs/05 §4.9: resolved workspace (cookie → default → personal).
 * POST /api/orgs/current — switch (validates membership; sets cookie + sticky default).
 */
export const GET = handleRoute(async () => {
  const { supabase, user } = await requireWorkspace()
  const scope = await resolveWorkspace(supabase, user.id)
  if (scope.kind === 'personal') return { workspace: { kind: 'personal' } }
  const membership = await getMembership(supabase, user.id, scope.orgId)
  return {
    workspace: {
      kind: 'org',
      org: membership ? { ...membership.org, role: membership.role } : null,
    },
  }
})

export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, user } = await requireWorkspace()
  const input = SwitchWorkspaceInput.parse(await request.json())
  const workspace = await switchWorkspace(supabase, user.id, input.organization_id)
  return { workspace }
})
