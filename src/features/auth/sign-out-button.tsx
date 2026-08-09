'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/** Sign out → /login (docs/02 §1). Ghost button in the shell's top bar. */
export function SignOutButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function signOut() {
    setLoading(true)
    try {
      await createClient().auth.signOut()
    } finally {
      router.push('/login')
      router.refresh()
    }
  }

  return (
    <button
      onClick={signOut}
      disabled={loading}
      className="rounded-lg px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-slate-100 disabled:opacity-50"
    >
      {loading ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
