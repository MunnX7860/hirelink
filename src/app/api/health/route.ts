import { createClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'
import { handleRoute } from '@/lib/errors'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * GET /api/health — docs/05 §4.8 (PUBLIC, no internals beyond build sha).
 * DB probe uses the ANON key deliberately: RLS restricts data, and the service-role
 * client is barred from general use (docs/14 §5). A successful (empty) query still
 * proves reachability.
 */
export const GET = handleRoute(async () => {
  const probe = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  })
  const { error } = await probe.from('users').select('id').limit(1)

  return {
    ok: true,
    db: !error,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
  }
})
