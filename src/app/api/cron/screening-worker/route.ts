import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { createServiceClient } from '@/lib/supabase/service'
import { screeningWorkerTick } from '@/features/screening/worker'
import { env, features } from '@/lib/env'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** One slice per session; the engine self-budgets under this (17 §9.1). */
export const maxDuration = 60

/**
 * GET /api/cron/screening-worker — docs/17 §9.1: advances active screening
 * sessions without any browser open (progress, quota auto-resume, batch
 * polling). Vercel cron every minute (vercel.json; paid-plan cadence — Hobby
 * relies on advance-on-view, same self-healing invariant). Guarded by
 * CRON_SECRET: 404 when unconfigured, 401 on wrong/missing bearer.
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
  const result = await screeningWorkerTick(createServiceClient())
  const ms = Date.now() - startedAt
  logger.info('screening worker cron finished', { ...result, ms })
  return { ...result, ms }
})
