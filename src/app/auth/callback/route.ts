import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { logger, errorSummary } from '@/lib/logger'

/**
 * OAuth callback — docs/02 §1. Exchanges the auth `code` for a session.
 * Failure → /login?error=oauth with a human message (never raw internals).
 * `next` is an optional in-app path (open-redirect guarded).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next')
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=oauth`)
  }

  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) throw error
    return NextResponse.redirect(`${origin}${safeNext}`)
  } catch (err) {
    logger.warn('oauth callback failed', { ...errorSummary(err) })
    return NextResponse.redirect(`${origin}/login?error=oauth`)
  }
}
