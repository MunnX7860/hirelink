import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { createServiceClient } from '@/lib/supabase/service'
import { purgeDeletedOrgs } from '@/features/orgs/server'
import { env, features } from '@/lib/env'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/cron/org-purge — docs/11 §7: hard-delete orgs past the 7-day soft-delete
 * grace window. Data rows are re-homed to their creators' personal workspaces first
 * (never destroyed). Vercel cron daily 04:00 UTC (vercel.json); guarded by CRON_SECRET —
 * 404 when unconfigured (feature-gated like /api/cron/reconcile), 401 on wrong/missing bearer.
 */
export const GET = handleRoute(async (_ctx, request: Request) => {
  if (!features.cron) {
    throw new AppError(ErrorCode.NOT_FOUND, 'Not found.')
  }
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${env.CRON_SECRET}`) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid cron credentials.')
  }

  const startedAt = Date.now()
  const result = await purgeDeletedOrgs(createServiceClient())
  logger.info('org purge cron finished', { ...result, ms: Date.now() - startedAt })
  return result
})
