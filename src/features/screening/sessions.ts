import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, ErrorCode } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import { PROMPT_VERSIONS } from '@/lib/ai/prompts'
import { makeBatchClient } from '@/lib/ai/batch'
import { getJob } from '@/features/jobs/server'
import { resolveScopeAiKey, resolveScopeAiOrNull } from '@/features/ai/server'
import type { Scope } from '@/features/orgs/scope'
import {
  canCancelSession,
  canRetrySession,
  groupResultsForDisplay,
  isActiveSessionStatus,
  poolApplicationsFilter,
  type CreateSessionInputValue,
  type DisplayResultRow,
  type GroupedSessionResults,
  type ScreeningPoolValue,
  type SessionStatusValue,
} from '@/features/screening/session-schemas'

/**
 * AI Screening Sessions (docs/17 §7–§9). Pool membership is SNAPSHOTTED into
 * per-candidate result rows at create; history is append-only (§14.4 — the
 * session row itself is the audit of who-instructed-what-when).
 * Processing itself lives in process.ts (after()-kicked at create, 5.4 worker).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

const SNAPSHOT_INSERT_CHUNK = 500

export interface SessionSummary {
  id: string
  pool: ScreeningPoolValue
  instruction: string
  max_results: number
  status: SessionStatusValue
  pool_size: number
  processed: number
  failed: number
  engine: 'interactive' | 'batch'
  model: string
  prompt_version: string
  created_at: string
  started_at: string | null
  completed_at: string | null
  created_by_name: string
}

interface SessionDbRow {
  id: string
  owner_id: string
  pool: string
  instruction: string
  max_results: number
  provider: string
  model: string
  prompt_version: string
  engine: string
  status: string
  pool_size: number
  processed: number
  failed: number
  created_at: string
  started_at: string | null
  completed_at: string | null
}

function toSummary(row: SessionDbRow, nameByUserId: Map<string, string>): SessionSummary {
  return {
    id: row.id,
    pool: row.pool as ScreeningPoolValue,
    instruction: row.instruction,
    max_results: row.max_results,
    status: row.status as SessionStatusValue,
    pool_size: row.pool_size,
    processed: row.processed,
    failed: row.failed,
    engine: row.engine === 'batch' ? 'batch' : 'interactive',
    model: row.model,
    prompt_version: row.prompt_version,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_by_name: nameByUserId.get(row.owner_id) ?? 'Unknown',
  }
}

// ── Pool counters (17 §12 "Qualified 500 · Review 12 · DNMC 488") ─────────────

export interface ScreeningCounters {
  qualified: number
  review_required: number
  does_not_meet_mandatory: number
  unscreened: number
  total: number
}

/** Counts by screening_status for a job (pool picker live counts + detail card). */
export async function getJobScreeningCounters(
  client: Client,
  scope: Scope,
  jobId: string,
): Promise<ScreeningCounters | null> {
  const job = await getJob(client, scope, jobId)
  if (!job) return null
  const { data, error } = await client
    .from('applications')
    .select('screening_status')
    .eq('job_id', jobId)
    .limit(100_000)
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load screening counts.', { cause: error })
  const counters: ScreeningCounters = {
    qualified: 0,
    review_required: 0,
    does_not_meet_mandatory: 0,
    unscreened: 0,
    total: 0,
  }
  for (const row of (data ?? []) as Array<{ screening_status: string | null }>) {
    counters.total += 1
    if (row.screening_status === 'qualified') counters.qualified += 1
    else if (row.screening_status === 'review_required') counters.review_required += 1
    else if (row.screening_status === 'does_not_meet_mandatory')
      counters.does_not_meet_mandatory += 1
    else counters.unscreened += 1
  }
  return counters
}

// ── Create (POST /api/ai/screenings) ──────────────────────────────────────────

export interface CreatedSession {
  session: SessionSummary
  /** Candidate rows snapshotted into the pool (17 §7). */
  snapshotted: number
}

export async function createScreeningSession(
  client: Client,
  scope: Scope,
  input: CreateSessionInputValue,
): Promise<CreatedSession> {
  const job = await getJob(client, scope, input.job_id)
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')

  // 17 §11: AI strictly optional — create gate.
  const ai = await resolveScopeAiOrNull(client, scope)
  if (!ai) {
    throw new AppError(ErrorCode.AI_NOT_CONFIGURED, 'Add your Gemini key in Settings → AI')
  }

  // 05 §4.10: one active session per job.
  const { data: active, error: activeError } = await client
    .from('ai_screening_sessions')
    .select('id, status')
    .eq('job_id', input.job_id)
    .in('status', ['queued', 'processing'])
    .limit(1)
  if (activeError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not check running sessions.', {
      cause: activeError,
    })
  if (
    ((active ?? []) as Array<{ id: string; status: string }>).some((s) =>
      isActiveSessionStatus(s.status),
    )
  ) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'A screening session is already running for this job — wait for it to finish.',
    )
  }

  // Pool snapshot (17 §7): membership frozen at create.
  const filter = poolApplicationsFilter(input.pool)
  let query = client.from('applications').select('id, applicant_id').eq('job_id', input.job_id)
  if (filter.kind === 'screening') query = query.in('screening_status', filter.statuses)
  else query = query.neq('status', 'archived')
  const { data: poolRows, error: poolError } = await query.limit(100_000)
  if (poolError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not snapshot the pool.', { cause: poolError })
  const pool = (poolRows ?? []) as Array<{ id: string; applicant_id: string }>

  // Frozen-at-start identity (17 §7): creator, model, prompt_version.
  const { data: inserted, error: insertError } = await client
    .from('ai_screening_sessions')
    .insert({
      job_id: input.job_id,
      owner_id: scope.ownerId,
      organization_id: job.organization_id ?? null,
      pool: input.pool,
      instruction: input.instruction,
      max_results: input.max_results,
      provider: 'gemini',
      model: ai.provider.model,
      prompt_version: PROMPT_VERSIONS.screen_candidates,
      engine: 'interactive',
      status: 'queued',
      pool_size: pool.length,
    })
    .select('*')
    .single()
  if (insertError || !inserted) {
    throw new AppError(ErrorCode.INTERNAL, 'Could not create the screening session.', {
      cause: insertError,
    })
  }
  const session = inserted as SessionDbRow

  // pending-result rows (retry unit = one row, 17 §9.3) — chunked inserts.
  for (let i = 0; i < pool.length; i += SNAPSHOT_INSERT_CHUNK) {
    const slice = pool.slice(i, i + SNAPSHOT_INSERT_CHUNK).map((app) => ({
      session_id: session.id,
      application_id: app.id,
      applicant_id: app.applicant_id,
      status: 'pending',
    }))
    const { error } = await client.from('ai_screening_results').insert(slice)
    if (error)
      throw new AppError(ErrorCode.INTERNAL, 'Could not snapshot the pool.', { cause: error })
  }

  const me = new Map([[scope.ownerId, 'You']])
  return { session: toSummary(session, me), snapshotted: pool.length }
}

// ── List (GET /api/ai/screenings?job_id=) ─────────────────────────────────────

export async function listScreeningSessions(
  client: Client,
  scope: Scope,
  jobId: string,
): Promise<{ sessions: SessionSummary[] } | null> {
  const job = await getJob(client, scope, jobId)
  if (!job) return null
  const { data, error } = await client
    .from('ai_screening_sessions')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load screening sessions.', { cause: error })
  const rows = (data ?? []) as SessionDbRow[]

  const ownerIds = [...new Set(rows.map((r) => r.owner_id))]
  const nameByUserId = new Map<string, string>()
  if (ownerIds.length > 0) {
    const { data: users } = await client.from('users').select('id, full_name').in('id', ownerIds)
    for (const u of (users ?? []) as Array<{ id: string; full_name: string | null }>) {
      nameByUserId.set(u.id, u.full_name ?? 'Unknown')
    }
  }
  return { sessions: rows.map((r) => toSummary(r, nameByUserId)) }
}

// ── Detail (GET /api/ai/screenings/:id) ───────────────────────────────────────

export interface SessionDetail {
  session: SessionSummary
  job: { id: string; title: string }
  results: GroupedSessionResults
}

export async function getScreeningSession(
  client: Client,
  scope: Scope,
  sessionId: string,
): Promise<SessionDetail | null> {
  const { data: sessionRow, error: sessionError } = await client
    .from('ai_screening_sessions')
    .select('*, job:jobs!inner(id, title, owner_id, organization_id)')
    .eq('id', sessionId)
    .maybeSingle()
  if (sessionError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the session.', { cause: sessionError })
  if (!sessionRow) return null
  const jobEmbed = (
    sessionRow as {
      job?: { id: string; title: string; owner_id: string; organization_id: string | null }
    }
  ).job
  if (!jobEmbed) return null
  // Scope containment via the parent job (docs/11 §1 — 404 semantics).
  const job = await getJob(client, scope, jobEmbed.id)
  if (!job) return null

  const { data: rows, error: rowsError } = await client
    .from('ai_screening_results')
    .select(
      'id, application_id, applicant_id, status, error, rank, category, score, reasons, evidence, uncertainties, applicant:applicants!inner(full_name)',
    )
    .eq('session_id', sessionId)
  if (rowsError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load session results.', { cause: rowsError })

  const displayRows: DisplayResultRow[] = (
    (rows ?? []) as unknown as Array<
      Record<string, unknown> & {
        applicant: { full_name: string | null }[] | { full_name: string | null } | null
      }
    >
  ).map((r) => {
    const embed = Array.isArray(r.applicant) ? (r.applicant[0] ?? null) : r.applicant
    return {
      applicationId: r.application_id as string,
      applicantId: r.applicant_id as string,
      applicantName: embed?.full_name ?? 'Candidate',
      status: r.status as DisplayResultRow['status'],
      error: (r.error as string | null) ?? null,
      category: (r.category as DisplayResultRow['category']) ?? null,
      rank: (r.rank as number | null) ?? null,
      score: (r.score as number | null) ?? null,
      reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
      evidence: Array.isArray(r.evidence) ? (r.evidence as string[]) : [],
      uncertainties: Array.isArray(r.uncertainties) ? (r.uncertainties as string[]) : [],
    }
  })

  const session = sessionRow as unknown as SessionDbRow
  const nameByUserId = new Map([[session.owner_id, 'You']])
  const { data: owner } = await client
    .from('users')
    .select('id, full_name')
    .eq('id', session.owner_id)
    .maybeSingle()
  const ownerName = (owner as { full_name: string | null } | null)?.full_name
  if (ownerName) nameByUserId.set(session.owner_id, ownerName)

  return {
    session: toSummary(session, nameByUserId),
    job: { id: jobEmbed.id, title: jobEmbed.title },
    results: groupResultsForDisplay(displayRows, session.max_results),
  }
}

/** Processor-facing row loader (process.ts) — kept here so queries stay in one file. */
export interface SessionJobContext {
  session: {
    id: string
    job_id: string
    owner_id: string
    organization_id: string | null
    instruction: string
    max_results: number
    status: string
    engine: string
    engine_ref: string | null
    processed: number
    failed: number
    pool_size: number
  }
  job: {
    id: string
    title: string
    description: string | null
    screening_config: unknown
    owner_id: string
    organization_id: string | null
  }
}

export async function loadSessionJobContext(
  client: Client,
  sessionId: string,
): Promise<SessionJobContext | null> {
  const { data, error } = await client
    .from('ai_screening_sessions')
    .select(
      'id, job_id, owner_id, organization_id, instruction, max_results, status, engine, engine_ref, processed, failed, pool_size, job:jobs!inner(id, title, description, screening_config, owner_id, organization_id)',
    )
    .eq('id', sessionId)
    .maybeSingle()
  if (error) {
    logger.error('screening session load failed', { ...errorSummary(error) })
    return null
  }
  if (!data) return null
  return data as unknown as SessionJobContext
}

// ── Retry + cancel (POST …/:id/retry|cancel — docs/05 §4.10, 17 §9.3) ────────

interface ScopedSessionRow {
  id: string
  owner_id: string
  status: string
  failed: number
  engine: string
  engine_ref: string | null
}

/** Scope-checked loader for mutation endpoints (docs/11 §1 — 404 semantics). */
async function loadScopedSession(
  client: Client,
  scope: Scope,
  sessionId: string,
): Promise<ScopedSessionRow | null> {
  const { data, error } = await client
    .from('ai_screening_sessions')
    .select('id, owner_id, status, failed, engine, engine_ref, job:jobs!inner(id)')
    .eq('id', sessionId)
    .maybeSingle()
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load the session.', { cause: error })
  if (!data) return null
  const embed = (data as { job?: { id: string }[] | { id: string } | null }).job
  const jobRef = Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null)
  if (!jobRef) return null
  const job = await getJob(client, scope, jobRef.id)
  if (!job) return null
  return data as unknown as ScopedSessionRow
}

export interface RetryOutcome {
  /** failed rows flipped back to pending (the §9.3 retry unit). */
  requeued: number
  /** rows still pending from an interrupted/key-broken run, now resumed. */
  resumed: number
}

/**
 * Retry re-queues FAILED rows individually and revives the terminal session —
 * fresh and engine-agnostic (batch provenance is RESET so the §9.2 upgrade
 * decision re-evaluates on the real pending volume). Nothing to redo → 0s
 * (the route answers a plain 200 no-op).
 */
export async function retryScreeningSession(
  client: Client,
  scope: Scope,
  sessionId: string,
): Promise<RetryOutcome | null> {
  const session = await loadScopedSession(client, scope, sessionId)
  if (!session) return null
  if (!canRetrySession(session.status)) {
    throw new AppError(ErrorCode.CONFLICT, 'This session is still running — stop it first.')
  }

  const { data: requeuedRows, error: requeueError } = await client
    .from('ai_screening_results')
    .update({ status: 'pending', error: null })
    .eq('session_id', sessionId)
    .eq('status', 'failed')
    .select('id')
  if (requeueError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not re-queue failed candidates.', {
      cause: requeueError,
    })
  const requeued = (requeuedRows ?? []).length

  const { count: pendingCount, error: pendingError } = await client
    .from('ai_screening_results')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('status', 'pending')
  if (pendingError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not count remaining candidates.', {
      cause: pendingError,
    })
  const resumed = pendingCount ?? 0

  if (requeued === 0 && resumed === 0) return { requeued: 0, resumed: 0 }

  const { error: updateError } = await client
    .from('ai_screening_sessions')
    .update({
      status: 'processing',
      completed_at: null,
      locked_at: null,
      // The requeued rows stop counting as failed NOW; fresh failures re-count.
      failed: Math.max(0, session.failed - requeued),
      engine: 'interactive',
      engine_ref: null,
    })
    .eq('id', sessionId)
  if (updateError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not revive the session.', {
      cause: updateError,
    })
  return { requeued, resumed }
}

/**
 * Cancel an in-flight session (17 §9.3). A live Gemini Batch is cancelled
 * remotely best-effort — the local session is the source of truth and NEVER
 * blocks on the provider (D4). Pending rows stay unscreened; retry revives.
 */
export async function cancelScreeningSession(
  client: Client,
  scope: Scope,
  sessionId: string,
): Promise<{ cancelled: true } | null> {
  const session = await loadScopedSession(client, scope, sessionId)
  if (!session) return null
  if (!canCancelSession(session.status)) {
    throw new AppError(ErrorCode.CONFLICT, 'This session is no longer running.')
  }

  if (session.engine === 'batch' && session.engine_ref) {
    const key = await resolveScopeAiKey(client, scope)
    if (key) {
      // Best-effort: cancelBatch absorbs its own failures (D4 by design).
      await makeBatchClient({ apiKey: key.apiKey, model: key.model }).cancelBatch(
        session.engine_ref,
      )
    }
  }

  const { error: updateError } = await client
    .from('ai_screening_sessions')
    .update({
      status: 'cancelled',
      completed_at: new Date().toISOString(),
      locked_at: null,
    })
    .eq('id', sessionId)
  if (updateError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not cancel the session.', {
      cause: updateError,
    })
  return { cancelled: true }
}
