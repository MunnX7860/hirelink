import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { assertCapability, requireWorkspace } from '@/features/orgs/server'
import { getIntegration } from '@/lib/integrations/resolve'
import { z } from 'zod'

export const runtime = 'nodejs'

type RouteContext = { params: Promise<{ type: string }> }

const IntegrationType = z.enum(['google_drive', 'telegram', 'email', 'ai'])

/**
 * DELETE /api/integrations/:type — docs/05 §4.6/§4.9: disconnect = credentials deleted,
 * idempotent. Workspace-scoped (docs/11 §3): in an org context this disconnects the
 * ORG row (requires integrations.manage); in personal context the caller's own row.
 */
export const DELETE = handleRoute(async (_ctx, _request: Request, ctx: RouteContext) => {
  const { supabase, user, scope } = await requireWorkspace()

  const { type } = await ctx.params
  const parsed = IntegrationType.safeParse(type)
  if (!parsed.success) throw new AppError(ErrorCode.NOT_FOUND, 'Unknown integration type.')

  if (scope.kind === 'org') {
    assertCapability(scope, 'integrations.manage')
    const { error } = await supabase
      .from('integrations')
      .update({ status: 'disconnected', credentials_encrypted: null })
      .eq('organization_id', scope.orgId)
      .eq('type', parsed.data)
      .neq('status', 'disconnected')
    if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not disconnect.', { cause: error })
    return { ok: true, level: 'org' }
  }

  const existing = await getIntegration(supabase, user.id, parsed.data)
  if (existing) {
    const { error } = await supabase
      .from('integrations')
      .update({ status: 'disconnected', credentials_encrypted: null })
      .eq('id', existing.id)
    if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not disconnect.', { cause: error })
  }
  return { ok: true, level: 'personal' }
})
