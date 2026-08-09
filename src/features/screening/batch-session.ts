import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger, errorSummary } from '@/lib/logger'
import { AI_TEMPERATURE, buildScreenCandidatesPrompt } from '@/lib/ai/prompts'
import {
  BATCH_INLINE_MAX_BYTES,
  buildBatchCreateBody,
  estimateBatchBodyBytes,
  makeBatchClient,
  parseBatchItemResult,
  type BatchItem,
} from '@/lib/ai/batch'
import { resolveScopeAiKey } from '@/features/ai/server'
import { markIntegrationError } from '@/lib/integrations/resolve'
import type { Scope } from '@/features/orgs/scope'
import { parseScreeningConfig } from '@/features/screening/schemas'
import {
  BATCH_POOL_THRESHOLD,
  SCREENING_RESULT_JSON_SCHEMA,
} from '@/features/screening/session-schemas'
import {
  JOB_DESCRIPTION_CHARS,
  PACK_ID_CHUNK,
  loadAllPendingRows,
  packCandidates,
  renderJobQuestionnaireBlock,
  writeSingleResult,
} from '@/features/screening/packing'
import type { SessionJobContext } from '@/features/screening/sessions'

/**
 * Gemini Batch accelerator (docs/17 §9.2) — for pools ≥ BATCH_POOL_THRESHOLD
 * the whole pending pool is submitted as ONE Batch job (one prompt per
 * candidate, anonymized exactly like the interactive chunks; separate quota,
 * ~50% cost, 24h SLO). ANY create/poll failure falls back to the interactive
 * chunked engine — the browser and the session are never blocked (§9.3).
 *
 * Identity safety (§8.2.0): candidates travel as the SAME packed blocks the
 * interactive engine builds (labels/profile/answers/excerpt — applicant
 * identity columns never enter the prompt); the metadata key is the result
 * row id, so drain-time correlation never trusts labels.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

/** Per-candidate batch items: one verdict JSON — smaller cap than chunk calls. */
const BATCH_ITEM_MAX_OUTPUT_TOKENS = 1024

async function setSessionState(
  client: Client,
  sessionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.from('ai_screening_sessions').update(patch).eq('id', sessionId)
  if (error) logger.error('screening batch session write failed', { ...errorSummary(error) })
}

async function countRowsByStatus(
  client: Client,
  sessionId: string,
  status: string,
): Promise<number> {
  const { count, error } = await client
    .from('ai_screening_results')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId)
    .eq('status', status)
  if (error) {
    logger.warn('screening batch recount failed', { ...errorSummary(error) })
    return 0
  }
  return count ?? 0
}

/** Session-level terminal failure (17 §9.3 — actionable banner on the dashboard). */
async function failSession(client: Client, sessionId: string): Promise<void> {
  await setSessionState(client, sessionId, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    locked_at: null,
  })
}

/** Back to the interactive chunked engine — rows stay pending, nothing is lost. */
async function flipToInteractive(client: Client, sessionId: string): Promise<void> {
  await setSessionState(client, sessionId, {
    engine: 'interactive',
    engine_ref: null,
    locked_at: null, // release so the next ticker picks it up immediately
  })
}

/**
 * Create the remote Batch job for this session's pending pool.
 * 'interactive' = stay on the chunked engine (any reason); 'upgraded' = the
 * session row now points at a live batch (engine='batch', engine_ref=name).
 */
export async function tryUpgradeToBatch(
  client: Client,
  scope: Scope,
  ctx: SessionJobContext,
): Promise<'upgraded' | 'interactive'> {
  // The REAL pending volume gates the upgrade — not the frozen pool_size, so a
  // retried 500-pool with 3 failed rows NEVER re-batches 3 items (17 §9.3).
  const rows = await loadAllPendingRows(client, ctx.session.id)
  if (rows.length < BATCH_POOL_THRESHOLD) return 'interactive'

  const key = await resolveScopeAiKey(client, scope)
  if (!key) return 'interactive' // interactive surfaces the right user-facing state

  const questions = parseScreeningConfig(ctx.job.screening_config).questions
  const questionnaireBlock = renderJobQuestionnaireBlock(questions)
  const jobDescription = (ctx.job.description ?? '').slice(0, JOB_DESCRIPTION_CHARS)

  const items: BatchItem[] = []
  for (let i = 0; i < rows.length; i += PACK_ID_CHUNK) {
    const packed = await packCandidates(client, questions, rows.slice(i, i + PACK_ID_CHUNK))
    for (const c of packed) {
      items.push({
        key: c.rowId,
        request: {
          prompt: buildScreenCandidatesPrompt({
            jobTitle: ctx.job.title,
            jobDescription,
            questionnaireBlock,
            instruction: ctx.session.instruction,
            maxResults: ctx.session.max_results,
            // Single-candidate pack: same builder, label C1 (advisory — §8.2.0).
            candidates: [
              {
                label: 'C1',
                profileBlock: c.profileBlock,
                answersBlock: c.answersBlock,
                resumeExcerpt: c.resumeExcerpt,
              },
            ],
          }),
          temperature: AI_TEMPERATURE.parsing,
          maxOutputTokens: BATCH_ITEM_MAX_OUTPUT_TOKENS,
          jsonSchema: SCREENING_RESULT_JSON_SCHEMA,
        },
      })
    }
  }

  const body = buildBatchCreateBody(items, `screening-${ctx.session.id.slice(0, 8)}`)
  if (estimateBatchBodyBytes(body) > BATCH_INLINE_MAX_BYTES) {
    logger.warn('screening batch body too large — staying interactive', {
      session_id: ctx.session.id,
      items: items.length,
    })
    return 'interactive'
  }

  const batch = makeBatchClient({ apiKey: key.apiKey, model: key.model })
  const created = await batch.createBatch(items, `screening-${ctx.session.id.slice(0, 8)}`)
  if (!created.ok) {
    if (created.integrationBroken) await markIntegrationError(client, key.integrationId)
    // 429 / 400-class / 5xx / network — interactive takes over seamlessly (§9.2).
    logger.warn('screening batch create failed — staying interactive', {
      session_id: ctx.session.id,
      code: created.code,
      detail: created.detail,
    })
    return 'interactive'
  }

  const now = new Date().toISOString()
  await setSessionState(client, ctx.session.id, {
    engine: 'batch',
    engine_ref: created.name,
    status: 'processing',
    ...(ctx.session.status === 'queued' ? { started_at: now } : {}),
    locked_at: now,
  })
  // Keep the caller's context truthful for the immediate tick that follows.
  ctx.session.engine = 'batch'
  ctx.session.engine_ref = created.name
  logger.info('screening session upgraded to batch', {
    session_id: ctx.session.id,
    batch: created.name,
    items: items.length,
  })
  return 'upgraded'
}

export type BatchTickOutcome = 'running' | 'completed' | 'fallback' | 'failed'

/**
 * Poll the remote batch once and advance the session state machine:
 *  - running    → counters mirrored from batchStats, lease refreshed
 *  - completed  → all pending rows drained (keys correlate), counters recounted
 *  - fallback   → batch unsupported/failed wholesale → interactive continues
 *  - failed     → key broken/rejected or integration gone (17 §9.3 banner)
 */
export async function tickBatchSession(
  client: Client,
  scope: Scope,
  ctx: SessionJobContext,
): Promise<BatchTickOutcome> {
  const sessionId = ctx.session.id
  const batchName = ctx.session.engine_ref
  if (!batchName) {
    await flipToInteractive(client, sessionId)
    return 'fallback'
  }

  const key = await resolveScopeAiKey(client, scope)
  if (!key) {
    // Key removed/undecryptable mid-run — same actionable failure as interactive.
    await failSession(client, sessionId)
    return 'failed'
  }

  const batch = makeBatchClient({ apiKey: key.apiKey, model: key.model })
  const poll = await batch.pollBatch(batchName)
  if (!poll.ok) {
    if (poll.integrationBroken) {
      await markIntegrationError(client, key.integrationId)
      await failSession(client, sessionId)
      return 'failed'
    }
    if (poll.code === 'ai_batch_unsupported') {
      // e.g. model lost batch support — the chunked engine takes over (§9.2).
      await flipToInteractive(client, sessionId)
      return 'fallback'
    }
    // Network/429/5xx — transient: stay on batch, refresh the lease, next tick.
    await setSessionState(client, sessionId, { locked_at: new Date().toISOString() })
    return 'running'
  }

  if (!poll.done) {
    await setSessionState(client, sessionId, {
      processed: poll.succeededCount,
      failed: poll.failedCount,
      locked_at: new Date().toISOString(),
    })
    return 'running'
  }

  if (!poll.succeeded) {
    // Batch FAILED/CANCELLED/EXPIRED as a whole — candidates were never harmed;
    // rows stay pending and the interactive engine re-screens them (§9.3).
    logger.warn('screening batch ended without success — falling back to interactive', {
      session_id: sessionId,
      batch: batchName,
    })
    await flipToInteractive(client, sessionId)
    return 'fallback'
  }

  // Drain: metadata key = result row id (authoritative); the label is advisory.
  const textByKey = new Map<string, string>()
  for (const r of poll.responses) {
    if (r.key && r.text) textByKey.set(r.key, r.text)
  }
  const pending = await loadAllPendingRows(client, sessionId)
  for (const row of pending) {
    const text = textByKey.get(row.id)
    if (!text) {
      await writeSingleResult(client, row.id, null, 'AI did not return this candidate')
      continue
    }
    const result = parseBatchItemResult(text)
    if (!result) {
      await writeSingleResult(client, row.id, null, 'AI returned unreadable output')
      continue
    }
    await writeSingleResult(client, row.id, result)
  }

  // Recount from the rows themselves — correct across drains AND retries (§9.3).
  const [okCount, failedCount] = await Promise.all([
    countRowsByStatus(client, sessionId, 'ok'),
    countRowsByStatus(client, sessionId, 'failed'),
  ])
  await setSessionState(client, sessionId, {
    status: 'completed',
    processed: okCount,
    failed: failedCount,
    completed_at: new Date().toISOString(),
    locked_at: null,
  })
  return 'completed'
}
