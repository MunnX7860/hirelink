import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildGoogleOAuthClient } from '@/lib/integrations/resolve'
import { verifyOAuthState } from '@/lib/oauth-state'
import { encryptSecret } from '@/lib/crypto'
import { logger, errorSummary } from '@/lib/logger'
import { can } from '@/lib/authz'

export const runtime = 'nodejs'

/**
 * Reads the email claim out of the id_token Google just returned.
 *
 * Not verified cryptographically on purpose: this token came straight back from
 * Google's token endpoint over TLS in a request we initiated, so there is no
 * untrusted party in between — the signature check guards the case where a token
 * arrives from a client, which is not this one. Returns null on anything
 * unexpected so the caller can fail closed.
 */
function emailFromIdToken(idToken: string | null | undefined): string | null {
  if (!idToken) return null
  const payload = idToken.split('.')[1]
  if (!payload) return null
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
      email?: unknown
      email_verified?: unknown
    }
    if (typeof json.email !== 'string' || !json.email) return null
    // An unverified address would let someone send as a mailbox they don't own.
    if (json.email_verified === false) return null
    return json.email
  } catch {
    return null
  }
}

/**
 * GET /api/integrations/gmail/callback — docs/09 §1.
 * Mirrors the Drive callback (docs/07 §2/§3): verify signed state + one-time
 * nonce, exchange the code, store only after the tokens are encrypted. The
 * granted address lands in `config.address` — without it the sender is unusable,
 * so a missing/unverified email fails the connection rather than storing a
 * half-working row.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const settingsUrl = `${origin}/dashboard/settings`
  const fail = (flag: string) => NextResponse.redirect(`${settingsUrl}?gmail_error=${flag}`)

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  if (!code || !state) return fail('oauth')

  const payload = verifyOAuthState(state)
  if (!payload) return fail('state')

  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user || user.id !== payload.ownerId) return fail('session')

    const nonceKey = `oauth_state:${payload.nonce}`
    const { data: nonceRow } = await supabase
      .from('settings')
      .select('id')
      .eq('owner_id', user.id)
      .eq('key', nonceKey)
      .maybeSingle()
    if (!nonceRow) return fail('state')
    await supabase.from('settings').delete().eq('owner_id', user.id).eq('key', nonceKey)

    const oauth2 = buildGoogleOAuthClient('gmail')
    const { tokens } = await oauth2.getToken(code)
    if (!tokens.refresh_token) return fail('no_refresh_token')

    const address = emailFromIdToken(tokens.id_token)
    if (!address) return fail('no_address')

    const credentials = encryptSecret(
      JSON.stringify({
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expiry_date: tokens.expiry_date,
      }),
    )

    // Org-targeted grants re-validate membership + capability NOW (docs/11 §3):
    // the role could have changed between starting the flow and returning.
    let orgId: string | null = null
    if (payload.orgId) {
      const { data: memberRow } = await supabase
        .from('organization_members')
        .select('role, organizations!inner(deleted_at)')
        .eq('organization_id', payload.orgId)
        .eq('user_id', user.id)
        .maybeSingle()
      const role = (memberRow as { role?: 'owner' | 'admin' | 'member' } | null)?.role ?? null
      if (!role || !can(role, 'integrations.manage')) return fail('org')
      orgId = payload.orgId
    }

    // Replace any existing sender in the SAME scope, so reconnecting with a
    // different mailbox doesn't leave two active rows racing maybeSingle().
    const replace = supabase
      .from('integrations')
      .update({ status: 'disconnected', credentials_encrypted: null })
      .eq('type', 'email')
      .neq('status', 'disconnected')
    await (orgId
      ? replace.eq('organization_id', orgId)
      : replace.eq('owner_id', user.id).is('organization_id', null))

    const { error } = await supabase.from('integrations').insert({
      owner_id: user.id,
      organization_id: orgId,
      type: 'email',
      status: 'active',
      credentials_encrypted: credentials,
      config: { address },
    })
    if (error) throw error

    return NextResponse.redirect(
      orgId ? `${settingsUrl}?connected=gmail&org=${orgId}` : `${settingsUrl}?connected=gmail`,
    )
  } catch (err) {
    logger.error('gmail callback failed', { ...errorSummary(err) })
    return fail('exchange')
  }
}
