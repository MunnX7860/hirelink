import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'

/**
 * SERVICE-ROLE client — BYPASSES RLS.
 * Importing this module is restricted by ESLint `no-restricted-imports` (docs/14 §5)
 * to exactly three places:
 *   1. the public apply route (docs/03 §5 — writes scoped by owner in code),
 *   2. integration OAuth callbacks,
 *   3. cron jobs.
 * Every query built with this client MUST carry an explicit owner/scope filter —
 * RLS will not save you here.
 */
export function createServiceClient() {
  return createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
