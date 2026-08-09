'use client'

import { useState } from 'react'
import { Button } from '@/ui/button'
import { IconGoogle } from '@/ui/icons'
import { createClient } from '@/lib/supabase/client'

/**
 * The single primary action on /login (docs/02 §1, docs/06 §1.2).
 * Starts Supabase Auth Google OAuth (openid email profile only — Drive scope is a
 * SEPARATE incremental grant, docs/00 D1).
 */
export function GoogleSignInButton() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setLoading(true)
    setError(null)
    try {
      // Deep-link preservation (Phase 4 invites): ?next=/invite/… survives the OAuth round-trip.
      const next = new URLSearchParams(window.location.search).get('next')
      const redirectTo =
        next && next.startsWith('/') && !next.startsWith('//')
          ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`
          : `${window.location.origin}/auth/callback`
      const supabase = createClient()
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          scopes: 'openid email profile',
        },
      })
      if (oauthError) throw oauthError
      // Browser is navigating to Google — keep the button busy.
    } catch {
      setError('Couldn’t reach Google. Check your connection and try again.')
      setLoading(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <Button
        variant="secondary"
        size="lg"
        className="w-full"
        loading={loading}
        onClick={signIn}
        aria-label="Continue with Google"
      >
        <IconGoogle />
        Continue with Google
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
