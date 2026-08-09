import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger, errorSummary } from '@/lib/logger'
import { AI_TEMPERATURE, buildScreenCandidatesPrompt } from '@/lib/ai/prompts'
import { callScopeAi } from '@/features/ai/server'
import type { Scope } from '@/features/orgs/scope'
import type { ResumeProfile } from '@/features/ai/schemas'
import {
  parseScreeningConfig,
  type AnswerScalar,
  type QuestionValue,
} from '@/features/screening/schemas'
import {
  SCREEN_CHUNK_SIZE,
  SCREENING_CHUNK_JSON_SCHEMA,
  ScreeningChunkOutput,
  describeRule,
  type ScreeningResultValue,
} from '@/features/screening/session-schemas'
import { loadSessionJobContext } from '@/features/screening/sessions'

/**
 * Screening session processor (docs/17 §9.1–§9.3) — the DB-state-machine
 * advance step. One Gemini call per ≤8-candidate chunk; per-candidate failures
 * NEVER fail the session; invoked from after() at create (5.3) and from the
 * §9 worker / advance-on-view (5.4) for large pools.
 *
 * Time budget: the loop stops when its slice expires, leaving the session in
 * `processing` — self-healing on the next tick. Uses the REQUEST-scoped client
 * (service-role stays out of /api/ai per 17 §10).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

/** Pace between chunk calls — free-tier headroom (~15 RPM ⇒ ~4 s/call), 17 §15. */
export const SCREEN_CALL_PACE_MS = 4000
/** Per-invocation slice (Vercel 60 s paid; Hobby truncates earlier, self-healing). */
export const SCREEN_TIME_BUDGET_MS = 50_000
/** One exponential backoff for a 429 before pausing the session (17 §9.2). */
export const SCREEN_RATE_LIMIT_BACKOFF_MS = 15_000

const RESUME_EXCERPT_CHARS = 1200
const JOB_DESCRIPTION_CHARS = 800

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Candidate context packing (17 §9.2 — ≤2k tokens/candidate) ───────────────

interface PendingRow {
  id: string
  application_id: string
  applicant_id: string
}

interface PackedCandidate {
  rowId: string
  applicationId: string
  applicantId: string
  label: string
  profileBlock: string
  answersBlock: string
  resumeExcerpt: string
}

function formatAnswer(value: AnswerScalar | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

function renderProfileBlock(profile: ResumeProfile): string {
  const lines: string[] = []
  if (profile.total_experience_years !== null)
    lines.push(`experience: ${profile.total_experience_years} years`)
  if (profile.location) lines.push(`location: ${profile.location}`)
  if (profile.current_ctc !== null) lines.push(`current_ctc (stated): ${profile.current_ctc}`)
  if (profile.expected_ctc !== null) lines.push(`expected_ctc (stated): ${profile.expected_ctc}`)
  if (profile.notice_period) lines.push(`notice_period: ${profile.notice_period}`)
  if (profile.skills.length > 0) lines.push(`skills: ${profile.skills.join(', ')}`)
  if (profile.tools.length > 0) lines.push(`tools: ${profile.tools.join(', ')}`)
  for (const e of profile.employers) {
    lines.push(
      `employer: ${e.name} — ${e.title ?? 'role'}${e.months ? `, ${e.months} months` : ''}${e.industry ? `, ${e.industry}` : ''}`,
    )
  }
  for (const e of profile.education) {
    lines.push(
      `education: ${e.degree}${e.institution ? `, ${e.institution}` : ''}${e.year ? `, ${e.year}` : ''}`,
    )
  }
  for (const p of profile.projects) {
    lines.push(`project: ${p.name}${p.summary ? ` — ${p.summary}` : ''}`)
  }
  if (profile.responsibilities_summary)
    lines.push(`responsibilities: ${profile.responsibilities_summary}`)
  return lines.join('\n')
}

function renderQuestionnaireBlock(
  questions: QuestionValue[],
  answers: Record<string, AnswerScalar>,
): string {
  const lines: string[] = []
  for (const q of questions) {
    const a = formatAnswer(answers[q.id])
    if (!a) continue
    lines.push(`Q: ${q.label}\nA: ${a}`)
  }
  return lines.join('\n')
}

/** Questionnaire block for the JOB context (expectations incl. mandatory rules). */
export function renderJobQuestionnaireBlock(questions: QuestionValue[]): string {
  return questions
    .filter((q) => q.classification !== 'informational')
    .map((q) => {
      const tiers =
        q.classification === 'mandatory' && q.rule
          ? `[mandatory — requires: ${describeRule(q.rule)}]`
          : '[preferred]'
      return `- ${tiers} ${q.label}`
    })
    .join('\n')
}

async function packCandidates(
  client: Client,
  questions: QuestionValue[],
  rows: PendingRow[],
): Promise<PackedCandidate[]> {
  const applicationIds = rows.map((r) => r.application_id)
  const applicantIds = rows.map((r) => r.applicant_id)

  const [answersRes, profilesRes, resumesRes] = await Promise.all([
    client
      .from('application_answers')
      .select('application_id, question_id, answer')
      .in('application_id', applicationIds),
    client
      .from('applicant_profiles')
      .select('applicant_id, payload')
      .in('applicant_id', applicantIds),
    client
      .from('resumes')
      .select('application_id, parsed_text, upload_status, created_at')
      .in('application_id', applicationIds)
      .eq('upload_status', 'uploaded')
      .order('created_at', { ascending: false }),
  ])

  const answersByApp = new Map<string, Record<string, AnswerScalar>>()
  for (const a of (answersRes.data ?? []) as Array<{
    application_id: string
    question_id: string
    answer: AnswerScalar
  }>) {
    const bucket = answersByApp.get(a.application_id) ?? {}
    bucket[a.question_id] = a.answer
    answersByApp.set(a.application_id, bucket)
  }
  const profileByApplicant = new Map<string, unknown>()
  for (const p of (profilesRes.data ?? []) as Array<{ applicant_id: string; payload: unknown }>) {
    profileByApplicant.set(p.applicant_id, p.payload)
  }
  const latestResumeTextByApp = new Map<string, string>()
  for (const r of (resumesRes.data ?? []) as Array<{
    application_id: string
    parsed_text: string | null
  }>) {
    if (!latestResumeTextByApp.has(r.application_id) && r.parsed_text) {
      latestResumeTextByApp.set(r.application_id, r.parsed_text)
    }
  }

  return rows.map((row, i) => ({
    rowId: row.id,
    applicationId: row.application_id,
    applicantId: row.applicant_id,
    label: `C${i + 1}`,
    profileBlock: (() => {
      const payload = profileByApplicant.get(row.applicant_id)
      if (!payload) return ''
      const parsed = payload as ResumeProfile // parse-v2 cache is zod-validated on write
      return renderProfileBlock(parsed)
    })(),
    answersBlock: renderQuestionnaireBlock(questions, answersByApp.get(row.application_id) ?? {}),
    resumeExcerpt: (latestResumeTextByApp.get(row.application_id) ?? '').slice(
      0,
      RESUME_EXCERPT_CHARS,
    ),
  }))
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
 * Advance one session through its pending rows. Safe to call repeatedly and
 * concurrently-avoided by the 409-create rule + status checks.
 */
export async function processScreeningSession(
  client: Client,
  scope: Scope,
  sessionId: string,
): Promise<{ remaining: number }> {
  const started = Date.now()
  const ctx = await loadSessionJobContext(client, sessionId)
  if (!ctx) return { remaining: -1 }
  const { session, job } = ctx
  if (!['queued', 'processing', 'quota_limited'].includes(session.status)) {
    return { remaining: -1 } // terminal states are never advanced
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

  const flushCounts = async () =>
    setSessionState(client, sessionId, {
      processed: session.processed + processedDelta,
      failed: session.failed + failedDelta,
    })

  try {
    for (;;) {
      if (Date.now() - started > SCREEN_TIME_BUDGET_MS) break // slice over; worker resumes

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

      const candidates = await packCandidates(client, questions, rows)
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
          })
          return { remaining: -1 }
        }
        if (call.retryable) {
          // 17 §9.2: one exponential backoff, then pause quota_limited (auto-resume next tick).
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
            // fall through to the success path below with retry.text
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
            })
            return { remaining: -1 }
          }
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
    // Unexpected infrastructure failure: leave the session in processing (self-healing).
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
    })
    return { remaining: 0 }
  }
  return { remaining }
}

// ── Chunk result application ──────────────────────────────────────────────────

async function markRowsFailed(client: Client, rows: PendingRow[], message: string): Promise<void> {
  for (const row of rows) {
    const { error } = await client
      .from('ai_screening_results')
      .update({ status: 'failed', error: message.slice(0, 200) })
      .eq('id', row.id)
    if (error) logger.warn('screening row fail-write failed', { ...errorSummary(error) })
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
      await markRowsFailed(
        client,
        [{ id: c.rowId, application_id: c.applicationId, applicant_id: c.applicantId }],
        'AI did not return this candidate',
      )
      continue
    }
    const { error } = await client
      .from('ai_screening_results')
      .update({
        status: 'ok',
        category: result.category,
        rank: result.rank,
        score: result.score,
        reasons: result.reasons,
        evidence: result.evidence,
        uncertainties: result.uncertainties,
      })
      .eq('id', c.rowId)
    if (error) {
      logger.warn('screening row write failed', { ...errorSummary(error) })
      failed += 1
      continue
    }
    ok += 1
  }
  return { ok, failed }
}
