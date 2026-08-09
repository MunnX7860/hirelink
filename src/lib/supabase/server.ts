import 'server-only'

import { cookies } from 'next/headers'
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { env } from '@/lib/env'

/**
 * Request-scoped Supabase client for Server Components, route handlers and
 * server actions. Authenticated as the *calling user* — RLS enforced (docs/03 §Rules).
 * For RLS-bypass usage see lib/supabase/service.ts (restricted imports).
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Called from a Server Component (cookie writes not allowed) — safe to
          // ignore because middleware refreshes the session (src/middleware.ts).
        }
      },
    },
  })
}
