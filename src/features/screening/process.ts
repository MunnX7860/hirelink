import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger, errorSummary } from '@/lib/logger'
import { AI_TEMPERATURE, buildScreenCandidatesPrompt } from '@/lib/ai/prompts'
import { callScopeAi } from '@/features/ai/server'
import type { Scope } from '@/features/orgs/scope'
import { parseScreeningConfig } from '@/features/screening/schemas'
import {
  SCREEN_CHUNK_SIZE,
  SCREENING_CHUNK_JSON_SCHEMA,
  ScreeningChunkOutput,
  isLeaseClaimable,
  shouldUpgradeToBatch,
  type ScreeningResultValue,
} from '@/features/screening/session-schemas'
import { loadSessionJobContext } from '@/features/screening/sessions'
import {
  JOB_DESCRIPTION_CHARS,
  PACK_ID_CHUNK,
  packCandidates,
  renderJobQuestionnaireBlock,
  writeSingleResult,
  type PackedCandidate,
  type PendingRow,
} from '@/features/screening/packing'
import { tickBatchSession, tryUpgradeToBatch } from '@/features/screening/batch-session'
import { writeScreeningSummaryArtifact } from '@/features/screening/summary-artifact'

/**
 * Screening session processor (docs/17 §9.1–§9.3) — the DB-state-machine
 * advance step. ONE advancer owns a session at a time (CAS lease below);
 * invoked from after() at create (5.3), the §9 cron worker and advance-on-view
 * (5.4). One Gemini call per ≤8-candidate chunk (interactive) or Gemini Batch
 * for pools ≥ 50 (accelerator, separate quota). Row failures NEVER sink a run.
 *
 * Client: request-scoped (RLS) from web routes; service client from the cron
 * worker (allowed zone, 17 §10) — the module is client-agnostic.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

/** Pace between chunk calls — free-tier headroom (~15 RPM ⇒ ~4 s/call), 17 §15. */
export const SCREEN_CALL_PACE_MS = 4000
/** Per-invocation slice (Vercel 60 s paid; Hobby truncates earlier, self-healing). */
export const SCREEN_TIME_BUDGET_MS = 50_000
/** One exponential backoff for a 429 before pausing the session (17 §9.2). */
export const SCREEN_RATE_LIMIT_BACKOFF_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Processing lease (17 §9.1 — single-processor guard) ──────────────────────

/**
 * Compare-and-swap claim: eligible by status+lock age (isLeaseClaimable), then
 * an atomic update guarded on the exact observed lock value. A lost race
 * returns false and the caller simply backs off.
 */
export async function claimSession(client: Client, sessionId: string): Promise<boolean> {
  const { data: row, error } = await client
    .from('ai_screening_sessions')
    .select('id, status, locked_at')
    .eq('id', sessionId)
    .maybeSingle()
  if (error || !row) return false
  const seen = row as { id: string; status: string; locked_at: string | null }
  if (!isLeaseClaimable(seen.status, seen.locked_at, Date.now())) return false

  let query = client
    .from('ai_screening_sessions')
    .update({ locked_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('status', seen.status)
  query =
    seen.locked_at === null ? query.is('locked_at', null) : query.eq('locked_at', seen.locked_at)
  const { data, error: updateError } = await query.select('id')
  if (updateError) {
    logger.error('screening lease claim failed', { ...errorSummary(updateError) })
    return false
  }
  return (data ?? []).length > 0
}

/** Graceful handoff (slice over / terminal states); a crash relies on lease expiry. */
export async function releaseSession(client: Client, sessionId: string): Promise<void> {
  const { error } = await client
    .from('ai_screening_sessions')
    .update({ locked_at: null })
    .eq('id', sessionId)
  if (error) logger.warn('screening lease release failed', { ...errorSummary(error) })
}

// ── Engine loop ───────────────────────────────────────────────────────────────

async function setSessionState(
  client: Client,
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from('ai_screening_sessions').update(patch).eq('id', sessionId)
  if (error) logger.error('screening session state write failed', { ...errorSummary(error) })
}

/**
 * Advance one session through its pending rows. Safe to call from every ticker —
 * the lease makes concurrent advancement impossible.
 */
export async function processScreeningSession(
  client: Client,
  scope: Scope,
  sessionId: string,
): Promise<{ remaining: number }> {
  // Single-processor guard (17 §9.1).
  if (!(await claimSession(client, sessionId))) return { remaining: -1 }

  const started = Date.now()
  const ctx = await loadSessionJobContext(client, sessionId)
  if (!ctx) {
    await releaseSession(client, sessionId)
    return { remaining: -1 }
  }
  const { session, job } = ctx
  if (!['queued', 'processing', 'quota_limited'].includes(session.status)) {
    await releaseSession(client, sessionId)
    return { remaining: -1 }
  }

  // Batch accelerator (17 §9.2): pool ≥ 50 → one Gemini Batch job (separate
  // quota, ~50% cost). Create/poll failure falls back to interactive, seamless.
  if (session.engine === 'batch' && session.engine_ref) {
    const outcome = await tickBatchSession(client, scope, ctx)
    if (outcome === 'completed') return { remaining: 0 }
    if (outcome === 'running' || outcome === 'failed') return { remaining: -1 }
    // 'fallback' → engine flipped to interactive; continue inline below.
  } else if (shouldUpgradeToBatch(session.engine, session.pool_size)) {
    const upgraded = await tryUpgradeToBatch(client, scope, ctx)
    if (upgraded === 'upgraded') {
      const outcome = await tickBatchSession(client, scope, ctx)
      return { remaining: outcome === 'completed' ? 0 : -1 }
    }
    // 'interactive' → chunky engine below.
  }

  const questions = parseScreeningConfig(job.screening_config).questions
  const questionnaireBlock = renderJobQuestionnaireBlock(questions)

  if (session.status !== 'processing') {
    await setSessionState(client, sessionId, {
      status: 'processing',
      ...(session.status === 'queued' ? { started_at: new Date().toISOString() } : {}),
    })
  }

  let processedDelta = 0
  let failedDelta = 0

  // flushCounts doubles as the lease refresh (locked_at=now each chunk).
  const flushCounts = async () =>
    setSessionState(client, sessionId, {
      processed: session.processed + processedDelta,
      failed: session.failed + failedDelta,
      locked_at: new Date().toISOString(),
    })

  let sliceOver = false
  try {
    for (;;) {
      if (Date.now() - started > SCREEN_TIME_BUDGET_MS) {
        sliceOver = true
        break // slice over; worker/advance-on-view resumes
      }

      const { data: pending, error: pendingError } = await client
        .from('ai_screening_results')
        .select('id, application_id, applicant_id')
        .eq('session_id', sessionId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(SCREEN_CHUNK_SIZE)
      if (pendingError) throw pendingError
      const rows = (pending ?? []) as PendingRow[]
      if (rows.length === 0) break

      const candidates = await packCandidates(client, questions, rows.slice(0, PACK_ID_CHUNK))
      const prompt = buildScreenCandidatesPrompt({
        jobTitle: job.title,
        jobDescription: (job.description ?? '').slice(0, JOB_DESCRIPTION_CHARS),
        questionnaireBlock,
        instruction: session.instruction,
        maxResults: session.max_results,
        candidates: candidates.map((c) => ({
          label: c.label,
          profileBlock: c.profileBlock,
          answersBlock: c.answersBlock,
          resumeExcerpt: c.resumeExcerpt,
        })),
      })

      const call = await callScopeAi(
        client,
        scope,
        {
          prompt,
          temperature: AI_TEMPERATURE.parsing,
          maxOutputTokens: 4096,
          jsonSchema: SCREENING_CHUNK_JSON_SCHEMA,
        },
        'Couldn’t screen this batch of candidates.',
      )

      if (!call.ok) {
        if (call.keyBroken) {
          // 17 §9.3: invalid key → whole session fails with actionable banner.
          await flushCounts()
          await setSessionState(client, sessionId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
            locked_at: null,
          })
          return { remaining: -1 }
        }
        if (call.retryable) {
          // 17 §9.2: one exponential backoff, then pause quota_limited (auto-resume).
          await sleep(SCREEN_RATE_LIMIT_BACKOFF_MS)
          const retry = await callScopeAi(
            client,
            scope,
            {
              prompt,
              temperature: AI_TEMPERATURE.parsing,
              maxOutputTokens: 4096,
              jsonSchema: SCREENING_CHUNK_JSON_SCHEMA,
            },
            'Couldn’t screen this batch of candidates.',
          )
          if (retry.ok) {
            const wrote = await writeChunkResults(client, retry.text, candidates)
            processedDelta += wrote.ok
            failedDelta += wrote.failed
            await flushCounts()
            continue
          }
          if (retry.keyBroken) {
            await flushCounts()
            await setSessionState(client, sessionId, {
              status: 'failed',
              completed_at: new Date().toISOString(),
              locked_at: null,
            })
            return { remaining: -1 }
          }
          // quota_limited pause KEEPS the fresh lock as the cooldown marker.
          await flushCounts()
          await setSessionState(client, sessionId, { status: 'quota_limited' })
          return { remaining: -1 }
        }
        // Timeout/network/parse-class: §11 — rows fail (retryable), session continues.
        await markRowsFailed(client, rows, call.message)
        failedDelta += rows.length
        await flushCounts()
        continue
      }

      const wrote = await writeChunkResults(client, call.text, candidates)
      processedDelta += wrote.ok
      failedDelta += wrote.failed
      await flushCounts()

      await sleep(SCREEN_CALL_PACE_MS)
    }
  } catch (err) {
    // Unexpected infrastructure failure: lock stays until lease expiry reclaims.
    logger.error('screening session advance crashed', {
      session_id: sessionId,
      ...errorSummary(err),
    })
    return { remaining: -1 }
  }

  // Pool drained?
  const { count } = await client
    .from('ai_screening_results')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('status', 'pending')
  const remaining = count ?? 0
  if (remaining === 0) {
    await flushCounts()
    await setSessionState(client, sessionId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      locked_at: null,
    })
    // 17 §13: immutable Drive summary artifact (write-once, D4-absorbed inside).
    await writeScreeningSummaryArtifact(client, scope, sessionId)
    return { remaining: 0 }
  }
  if (sliceOver) await releaseSession(client, sessionId) // immediate handoff to the next ticker
  return { remaining }
}

// ── Chunk result application ──────────────────────────────────────────────────

async function markRowsFailed(client: Client, rows: PendingRow[], message: string): Promise<void> {
  for (const row of rows) {
    await writeSingleResult(client, row.id, null, message)
  }
}

/**
 * Write one chunk's model output onto its rows. Invalid shape → rows failed
 * (17 §9.3); candidates missing from the output → failed('not returned');
 * over-production sliced by the schema (never fails a session).
 */
async function writeChunkResults(
  client: Client,
  raw: string,
  candidates: PackedCandidate[],
): Promise<{ ok: number; failed: number }> {
  let resultsMap = new Map<string, ScreeningResultValue>()
  try {
    const parsedJson = JSON.parse(raw) as unknown
    resultsMap = new Map(
      ScreeningChunkOutput.parse(parsedJson).results.map((r) => [r.candidate, r] as const),
    )
  } catch {
    await markRowsFailed(
      client,
      candidates.map((c) => ({
        id: c.rowId,
        application_id: c.applicationId,
        applicant_id: c.applicantId,
      })),
      'AI returned unreadable output',
    )
    return { ok: 0, failed: candidates.length }
  }

  let ok = 0
  let failed = 0
  for (const c of candidates) {
    const result = resultsMap.get(c.label)
    if (!result) {
      failed += 1
      await writeSingleResult(client, c.rowId, null, 'AI did not return this candidate')
      continue
    }
    const wrote = await writeSingleResult(client, c.rowId, result)
    if (wrote) ok += 1
    else failed += 1
  }
  return { ok, failed }
}
