import { after } from 'next/server'
import { AppError, ErrorCode, handleRoute } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import { requireWorkspace } from '@/features/orgs/server'
import { CreateSessionInput } from '@/features/screening/session-schemas'
import { createScreeningSession, listScreeningSessions } from '@/features/screening/sessions'
import { processScreeningSession } from '@/features/screening/process'

export const runtime = 'nodejs'
/** after() processing slice (17 §9.1); Hobby clamps lower — self-healing by design. */
export const maxDuration = 60

/**
 * POST /api/ai/screenings — docs/05 §4.10: create a screening session.
 * Pool is snapshotted to pending rows; processing kicks off immediately via
 * after() (the browser NEVER waits, 17 §9.1); the §9 worker (5.4) takes over
 * for large pools. 409 when a session is active for the job; 400 when no key.
 */
export const POST = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()
  const input = CreateSessionInput.parse(await request.json())

  const created = await createScreeningSession(supabase, scope, input)

  after(async () => {
    try {
      await processScreeningSession(supabase, scope, created.session.id)
    } catch (err) {
      logger.error('screening after-kickoff failed', { ...errorSummary(err) })
    }
  })

  return Response.json(created, { status: 201 })
})

/**
 * GET /api/ai/screenings?job_id= — docs/05 §4.10: append-only session history
 * for a job (newest first, capped at 50).
 */
export const GET = handleRoute(async (_ctx, request: Request) => {
  const { supabase, scope } = await requireWorkspace()
  const url = new URL(request.url)
  const jobId = url.searchParams.get('job_id')
  if (!jobId) throw new AppError(ErrorCode.VALIDATION_ERROR, 'job_id is required.')

  const result = await listScreeningSessions(supabase, scope, jobId)
  if (!result) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')
  return result
})
