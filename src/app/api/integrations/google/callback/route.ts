import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildGoogleOAuthClient } from '@/lib/integrations/resolve'
import { verifyOAuthState } from '@/lib/oauth-state'
import { encryptSecret } from '@/lib/crypto'
import { logger, errorSummary } from '@/lib/logger'
import { can } from '@/lib/authz'

export const runtime = 'nodejs'

/**
 * GET /api/integrations/google/callback — docs/07 §2/§3.
 * Verifies signed state + one-time nonce, exchanges the code, DISCARDS nothing
 * until tokens are safely encrypted and stored. Failures bounce to settings with
 * a human flag (never raw internals — docs/02 §10).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const settingsUrl = `${origin}/dashboard/settings`
  const fail = (flag: string) => NextResponse.redirect(`${settingsUrl}?drive_error=${flag}`)

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

    // One-time nonce check + consume (docs/07 §2).
    const nonceKey = `oauth_state:${payload.nonce}`
    const { data: nonceRow } = await supabase
      .from('settings')
      .select('id')
      .eq('owner_id', user.id)
      .eq('key', nonceKey)
      .maybeSingle()
    if (!nonceRow) return fail('state')
    await supabase.from('settings').delete().eq('owner_id', user.id).eq('key', nonceKey)

    // Exchange code → tokens (docs/07 §3.1).
    const oauth2 = buildGoogleOAuthClient()
    const { tokens } = await oauth2.getToken(code)
    if (!tokens.refresh_token) return fail('no_refresh_token') // prompt=consent should guarantee it

    const credentials = encryptSecret(
      JSON.stringify({
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        expiry_date: tokens.expiry_date,
      }),
    )

    // Phase 4 (docs/11 §3): state may target an org — re-validate membership/admin NOW.
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

    // Replace the connection in the SAME scope (personal vs org row — docs/11 §3).
    const replace = supabase
      .from('integrations')
      .update({ status: 'disconnected', credentials_encrypted: null })
      .eq('type', 'google_drive')
      .neq('status', 'disconnected')
    await (orgId
      ? replace.eq('organization_id', orgId)
      : replace.eq('owner_id', user.id).is('organization_id', null))

    const { error } = await supabase.from('integrations').insert({
      owner_id: user.id,
      organization_id: orgId,
      type: 'google_drive',
      status: 'active',
      credentials_encrypted: credentials,
      config: {},
    })
    if (error) throw error

    return NextResponse.redirect(
      orgId
        ? `${settingsUrl}?connected=google_drive&org=${orgId}`
        : `${settingsUrl}?connected=google_drive`,
    )
  } catch (err) {
    logger.error('google callback failed', { ...errorSummary(err) })
    return fail('exchange')
  }
}
