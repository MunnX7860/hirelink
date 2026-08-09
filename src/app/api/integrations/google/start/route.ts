import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { buildGoogleOAuthClient } from '@/lib/integrations/resolve'
import { createOAuthState } from '@/lib/oauth-state'
import { features } from '@/lib/env'
import { assertCapability, getMembership, requireWorkspace } from '@/features/orgs/server'
import { z } from 'zod'

export const runtime = 'nodejs'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file' // docs/07 §2 — only scope ever requested

const Body = z.object({ org_id: z.string().uuid().nullish() }).strict()

/**
 * POST /api/integrations/google/start — docs/05 §4.6/§4.9 + docs/02 §8.1.
 * Returns the Google consent URL (`drive.file`, offline, force consent) with our
 * signed one-time state (docs/07 §2). Body `{ org_id }` connects the SHARED
 * organization Drive instead (docs/11 §3) — requires integrations.manage there.
 */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, user } = await requireWorkspace()

  if (!features.googleDriveOAuth) {
    throw new AppError(
      ErrorCode.INTERNAL,
      'Google Drive connection is not configured on this deployment (missing GOOGLE_CLIENT_*).',
    )
  }

  let orgId: string | null = null
  const raw = await request.text()
  if (raw.trim().length > 0) {
    const body = Body.parse(JSON.parse(raw)) as { org_id?: string | null }
    if (body.org_id) {
      const membership = await getMembership(supabase, user.id, body.org_id)
      if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
      assertCapability(
        { kind: 'org', ownerId: user.id, orgId: body.org_id, role: membership.role },
        'integrations.manage',
      )
      orgId = body.org_id
    }
  }

  const { state, nonce } = createOAuthState(user.id, orgId)
  // One-time nonce — consumed by the callback (docs/07 §2).
  const { error } = await supabase.from('settings').insert({
    owner_id: user.id,
    key: `oauth_state:${nonce}`,
    value: { created_at: new Date().toISOString() },
  })
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not start the Google connection.', {
      cause: error,
    })

  const oauth2 = buildGoogleOAuthClient()
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // docs/07 §2 — guarantees a refresh token
    scope: [DRIVE_SCOPE],
    state,
  })
  return { url }
})
