'use client'

import { createBrowserClient } from '@supabase/ssr'

/**
 * Browser Supabase client — for Client Components (login button, sign-out).
 * Uses the anon key; all data access goes through RLS (docs/04 §6).
 * NEXT_PUBLIC_* values are inlined at build time (docs/14 §2.4 exception is
 * server-only lib/env.ts; public vars are safe here).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
