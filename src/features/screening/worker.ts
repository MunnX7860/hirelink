import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger, errorSummary } from '@/lib/logger'
import type { Scope } from '@/features/orgs/scope'
import { isLeaseClaimable } from '@/features/screening/session-schemas'
import { processScreeningSession } from '@/features/screening/process'

/**
 * Async screening worker tick (docs/17 §9.1) — the promise that large pools
 * never depend on a browser staying open. Runs from /api/cron/screening-worker
 * (Vercel cron, service client — the allowed zone per §10); the per-minute
 * cadence needs a paid plan, and on Hobby the advance-on-view self-heals
 * instead. ONE tick advances a few sessions by one time-boxed slice each; the
 * CAS lease (§9.1) makes double-processing impossible across tickers.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- service client generics differ per caller
type Client = SupabaseClient<any>

const WORKER_SCAN_LIMIT = 10
const DEFAULT_MAX_SESSIONS = 3
/** Leave headroom under the host's 60s maxDuration (one engine slice is 50s). */
const DEFAULT_TIME_BUDGET_MS = 45_000

export interface ScreeningWorkerTickResult {
  /** Active sessions seen via the partial index (17 §9.1). */
  scanned: number
  /** Skipped: quota-cooldown (§9.2) or a live lease held by another ticker. */
  skipped: number
  advanced: Array<{ session_id: string; remaining: number }>
}

export async function screeningWorkerTick(
  service: Client,
  options?: { maxSessions?: number; timeBudgetMs?: number },
): Promise<ScreeningWorkerTickResult> {
  const maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS
  const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  const started = Date.now()

  const { data, error } = await service
    .from('ai_screening_sessions')
    .select('id, owner_id, organization_id, status, locked_at, created_at')
    .in('status', ['queued', 'processing', 'quota_limited'])
    .order('created_at', { ascending: true })
    .limit(WORKER_SCAN_LIMIT)
  if (error) {
    logger.error('screening worker scan failed', { ...errorSummary(error) })
    return { scanned: 0, skipped: 0, advanced: [] }
  }
  const rows = (data ?? []) as Array<{
    id: string
    owner_id: string
    organization_id: string | null
    status: string
    locked_at: string | null
    created_at: string
  }>

  const now = Date.now()
  const claimable = rows.filter((r) => isLeaseClaimable(r.status, r.locked_at, now))
  const picked = claimable.slice(0, maxSessions)

  const advanced: Array<{ session_id: string; remaining: number }> = []
  for (const session of picked) {
    if (Date.now() - started > timeBudgetMs) break // next minute's tick continues
    // Act AS the session owner: integration + RLS identity live on owner/org;
    // role is unused by the AI resolution path (refForScope only).
    const scope: Scope = session.organization_id
      ? { kind: 'org', ownerId: session.owner_id, orgId: session.organization_id, role: 'member' }
      : { kind: 'personal', ownerId: session.owner_id }
    try {
      const result = await processScreeningSession(service, scope, session.id)
      advanced.push({ session_id: session.id, remaining: result.remaining })
    } catch (err) {
      // One crashing session must never sink the tick (17 §9.3).
      logger.error('screening worker advance crashed', {
        session_id: session.id,
        ...errorSummary(err),
      })
      advanced.push({ session_id: session.id, remaining: -1 })
    }
  }

  return { scanned: rows.length, skipped: rows.length - claimable.length, advanced }
}
