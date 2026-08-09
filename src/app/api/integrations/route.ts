import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { getIntegration, getOrgIntegration } from '@/lib/integrations/resolve'
import { requireWorkspace } from '@/features/orgs/server'

export const runtime = 'nodejs'

/**
 * GET /api/integrations — docs/05 §4.6/§4.9. Credentials are WRITE-ONLY: this endpoint
 * returns the safe shape only ({ type, status, config non-secret subset, created_at }).
 * Phase 4 (docs/11 §3): in an org workspace the response carries BOTH the org rows
 * (`level: 'org'`) and the caller's personal rows (`level: 'personal'`) so the UI can
 * label which connection actually serves the workspace (org wins).
 */
export const GET = handleRoute(async () => {
  const { supabase, user, scope } = await requireWorkspace()

  const types = ['google_drive', 'telegram', 'email', 'ai'] as const
  const rows: Array<{
    type: string
    status: string
    config: Record<string, unknown>
    created_at?: string
    level: 'org' | 'personal'
  }> = []

  for (const type of types) {
    const orgId = scope.kind === 'org' ? scope.orgId : null
    const personal = await getIntegration(supabase, user.id, type)
    // Email is a deployment-level capability, not a stored row today (docs/09 §1).
    void personal
    if (orgId) {
      const orgRow = await getOrgIntegration(supabase, orgId, type)
      if (orgRow && orgRow.status !== 'disconnected') {
        rows.push(shape(orgRow, 'org'))
      }
    }
    if (personal && personal.status !== 'disconnected') {
      rows.push(shape(personal, 'personal'))
    }
  }

  return {
    workspace:
      scope.kind === 'org' ? { kind: 'org', organization_id: scope.orgId } : { kind: 'personal' },
    data: rows,
  }
})

function shape(
  row: {
    type: string
    status: string
    config: Record<string, unknown>
  },
  level: 'org' | 'personal',
): { type: string; status: string; config: Record<string, unknown>; level: 'org' | 'personal' } {
  if (row.type === 'google_drive') {
    return {
      type: row.type,
      status: row.status,
      level,
      config: { root_folder_set: Boolean(row.config.root_folder_id) },
    }
  }
  if (row.type === 'telegram') {
    return {
      type: row.type,
      status: row.status,
      level,
      config: {
        chat_id: row.config.chat_id ?? null,
        bot_username: row.config.bot_username ?? null,
        shared: Boolean(row.config.shared),
      },
    }
  }
  if (row.type === 'ai') {
    return {
      type: row.type,
      status: row.status,
      level,
      config: {
        provider: row.config.provider ?? null,
        model: row.config.model ?? null,
        capabilities: row.config.capabilities ?? [], // docs/10 §2 capability declaration
        key_hint: row.config.key_hint ?? null,
      },
    }
  }
  throw new AppError(ErrorCode.INTERNAL, 'Unknown integration row.')
}
