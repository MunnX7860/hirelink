import { timingSafeEqual } from 'node:crypto'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { env, features } from '@/lib/env'
import { logger, errorSummary } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'
import { resolveDriveStorage, markIntegrationError } from '@/lib/integrations/resolve'
import { StorageProviderError } from '@/lib/storage/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SAMPLE_LIMIT = 200 // docs/07 §7: reconcile samples, not a full sweep

interface SampledResume {
  id: string
  applicant_id: string | null
  application_id: string
  storage_file_id: string
  owner_id: string
}

/**
 * GET /api/cron/reconcile — docs/05 §4.8 + docs/07 §7 + G4.
 * Vercel cron invokes with `Authorization: Bearer $CRON_SECRET`.
 * For a sample of recent `resumes.uploaded` rows, HEADs the Drive file; missing
 * files → `resume_failed` timeline event + integration warning (banner).
 */
export const GET = handleRoute(async (_ctx, request: Request) => {
  if (!features.cron) throw new AppError(ErrorCode.NOT_FOUND, 'Not found.')
  const auth = request.headers.get('authorization') ?? ''
  const expected = `Bearer ${env.CRON_SECRET ?? ''}`
  const a = Buffer.from(auth)
  const e = Buffer.from(expected)
  if (a.length !== e.length || !timingSafeEqual(a, e)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid cron credentials.')
  }

  const supabase = createServiceClient()

  // Explicit owner scope is carried on every row via jobs.owner_id — RLS is off
  // here (service client), so the join IS the scoping (lib/supabase/service.ts).
  const { data, error } = await supabase
    .from('resumes')
    .select(
      'id, applicant_id, application_id, storage_file_id, application:applications!inner(job:jobs!inner(owner_id))',
    )
    .eq('upload_status', 'uploaded')
    .not('storage_file_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(SAMPLE_LIMIT)
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not sample resumes.', { cause: error })

  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    applicant_id: (r.applicant_id as string | null) ?? null,
    application_id: r.application_id as string,
    storage_file_id: r.storage_file_id as string,
    owner_id: (
      (r.application as { job: { owner_id: string } | null } | null)?.job ?? {
        owner_id: '',
      }
    ).owner_id,
  })) as SampledResume[]

  const storageByOwner = new Map<string, Awaited<ReturnType<typeof resolveDriveStorage>>>()
  let checked = 0
  let missing = 0
  const ownersFlagged = new Set<string>()

  for (const row of rows) {
    if (!row.owner_id) continue
    if (!storageByOwner.has(row.owner_id)) {
      storageByOwner.set(
        row.owner_id,
        await resolveDriveStorage(supabase, { ownerId: row.owner_id }),
      )
    }
    const drive = storageByOwner.get(row.owner_id)
    if (!drive) continue // owner not connected — nothing to check against (degrade silently)
    checked += 1
    try {
      await drive.storage.getFileMetadata(row.storage_file_id)
    } catch (err) {
      if (err instanceof StorageProviderError && err.retryable) {
        // Transient provider error — next cron run retries; not evidence of loss.
        logger.warn('reconcile HEAD failed (retryable)', { file: row.id, ...errorSummary(err) })
        continue
      }
      missing += 1
      ownersFlagged.add(row.owner_id)
      const { error: eventError } = await supabase.from('timeline_events').insert({
        owner_id: row.owner_id,
        applicant_id: row.applicant_id,
        application_id: row.application_id,
        actor_id: null,
        type: 'resume_failed',
        payload: { reason: 'reconcile_missing_file', file_id: row.storage_file_id },
      })
      if (eventError)
        logger.error('reconcile event write failed', { file: row.id, ...errorSummary(eventError) })
    }
  }

  for (const ownerId of ownersFlagged) {
    const drive = storageByOwner.get(ownerId)
    if (drive) await markIntegrationError(supabase, drive.integrationId)
  }

  logger.info('reconcile complete', {
    checked,
    missing,
    owners_flagged: ownersFlagged.size,
  })
  return { checked, missing, owners_notified: ownersFlagged.size }
})
