import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { exportOwnData } from '@/features/settings/server'

export const runtime = 'nodejs'

/**
 * GET /api/users/me/export — docs/02 §9 "Export my data". Personal-workspace
 * data only (organization_id IS NULL) — org-shared data isn't solely the
 * caller's to export. RLS-scoped client only; no service client needed since
 * every row selected already passes the caller's own owner_id RLS policy.
 */
export const GET = handleRoute(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, 'Sign in required.')

  const bundle = await exportOwnData(supabase, user.id)
  return new Response(JSON.stringify(bundle, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="hirelink-export-${user.id.slice(0, 8)}.json"`,
    },
  })
})
