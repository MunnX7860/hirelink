import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { buildGoogleOAuthClient } from '@/lib/integrations/resolve'
import { createOAuthState } from '@/lib/oauth-state'
import { features } from '@/lib/env'
import { assertCapability, getMembership, requireWorkspace } from '@/features/orgs/server'
import { z } from 'zod'

export const runtime = 'nodejs'

/**
 * `gmail.send` only — the narrowest Gmail scope there is. It cannot read, list
 * or delete mail, which keeps this a SENSITIVE scope rather than a restricted
 * one: restricted Gmail scopes (readonly/modify/compose, full mailbox) drag in
 * an annual paid CASA security audit, and send does not.
 *
 * `openid email` rides along so the callback can learn which address was
 * granted, from the id_token. `gmail.send` alone cannot call users.getProfile.
 */
const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send']

const Body = z.object({ org_id: z.string().uuid().nullish() }).strict()

/**
 * POST /api/integrations/gmail/start — docs/09 §1.
 * Returns the Google consent URL for sending as the caller's own mailbox. Body
 * `{ org_id }` connects the SHARED organization sender instead (docs/11 §3) —
 * requires integrations.manage there.
 */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, user } = await requireWorkspace()

  if (!features.googleDriveOAuth) {
    // Same GOOGLE_CLIENT_* pair backs both Drive and Gmail.
    throw new AppError(
      ErrorCode.INTERNAL,
      'Google sign-in is not configured on this deployment (missing GOOGLE_CLIENT_*).',
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
  const { error } = await supabase.from('settings').insert({
    owner_id: user.id,
    key: `oauth_state:${nonce}`,
    value: { created_at: new Date().toISOString() },
  })
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not start the Gmail connection.', {
      cause: error,
    })

  const oauth2 = buildGoogleOAuthClient('gmail')
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // guarantees a refresh token (docs/07 §2)
    scope: GMAIL_SCOPES,
    state,
  })
  return { url }
})
