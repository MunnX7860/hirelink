import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { customAlphabet } from 'nanoid'
import { AppError, ErrorCode } from '@/lib/errors'
import { logger } from '@/lib/logger'
import { getJob } from '@/features/jobs/server'
import { assertCapability } from '@/features/orgs/server'
import type { Scope } from '@/features/orgs/scope'
import { isRowInScope } from '@/features/orgs/scope'
import { evaluateScreening } from '@/features/screening/engine'
import {
  parseScreeningConfig,
  validateAnswers,
  type AnswersInputValue,
  type PublicQuestionValue,
  type QuestionValue,
  type SaveScreeningConfigInputValue,
  type ScreeningConfigValue,
  type ScreeningStatusValue,
} from '@/features/screening/schemas'

/**
 * Screening service — docs/17 (Phase 5). Request-scoped (RLS) clients for
 * owner paths; the public apply path passes the service client (allowed zone)
 * for answer inserts. Rules NEVER leave toward public surfaces (17 §3.4) —
 * only `sanitizeQuestions` projections do.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

const questionId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6)

// ── Config (docs/05 §4.10) ───────────────────────────────────────────────────

export async function getScreeningConfig(
  client: Client,
  scope: Scope,
  jobId: string,
): Promise<{ job: { id: string; title: string }; config: ScreeningConfigValue } | null> {
  const job = await getJob(client, scope, jobId)
  if (!job) return null
  return {
    job: { id: job.id, title: job.title },
    config: parseScreeningConfig(job.screening_config),
  }
}

export async function saveScreeningConfig(
  client: Client,
  scope: Scope,
  jobId: string,
  input: SaveScreeningConfigInputValue,
): Promise<ScreeningConfigValue> {
  assertCapability(scope, 'jobs.write')
  const job = await getJob(client, scope, jobId)
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')

  // New questions get server-side nanoid-6 ids (never trust caller ids);
  // ids are stable across saves so historical answers keep joining.
  const questions: QuestionValue[] = input.questions.map((q) => ({
    ...q,
    id: q.id ?? questionId(),
  }))
  const config: ScreeningConfigValue = { questions }

  const { error } = await client.from('jobs').update({ screening_config: config }).eq('id', job.id)
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not save the questionnaire.', { cause: error })
  return config
}

/** Sanitized question projection for candidates (17 §3.4) — used by the page + public route. */
export function publicQuestionsFor(job: { screening_config?: unknown }): PublicQuestionValue[] {
  return parseScreeningConfig(job.screening_config).questions.map((q) => ({
    id: q.id,
    label: q.label,
    required: q.required,
    type: q.type,
    ...(q.options ? { options: q.options } : {}),
  }))
}

// ── Apply-time persistence + verdict (docs/17 §5) ───────────────────────────

/**
 * Persists cleaned answers + deterministic verdict for a FRESH application
 * (duplicate applies keep first-write answers — 17 decision 4). Called with the
 * service client from the apply route; every failure here is absorbed into a
 * warn-log (D4: a screening hiccup must never break an application).
 */
export async function persistAnswersAndVerdict(args: {
  client: Client
  jobOwnerId: string
  applicationId: string
  applicantId: string
  config: ScreeningConfigValue
  answers: AnswersInputValue
}): Promise<ScreeningStatusValue | null> {
  const { client, jobOwnerId, applicationId, applicantId, config } = args
  if (config.questions.length === 0) return null

  try {
    const validation = validateAnswers(config.questions, args.answers)
    const rows = Object.entries(validation.cleaned).map(([qid, answer]) => ({
      application_id: applicationId,
      applicant_id: applicantId,
      question_id: qid,
      answer: answer as unknown,
    }))
    if (rows.length > 0) {
      const { error } = await client.from('application_answers').insert(rows)
      if (error) throw error
    }

    const verdict = evaluateScreening(
      config.questions,
      validation.cleaned as Record<string, boolean | string | number | string[]>,
    )
    if (verdict.status) {
      const { error } = await client
        .from('applications')
        .update({ screening_status: verdict.status })
        .eq('id', applicationId)
      if (error) throw error
      await client.from('timeline_events').insert({
        owner_id: jobOwnerId,
        applicant_id: applicantId,
        application_id: applicationId,
        actor_id: null,
        type: 'questionnaire_screened',
        payload: {
          verdict: verdict.status,
          failed: verdict.details.filter((d) => d.outcome === 'fail').map((d) => d.questionId),
          review: verdict.details.filter((d) => d.outcome === 'review').map((d) => d.questionId),
          source: 'apply',
        },
      })
      return verdict.status
    }
    return null
  } catch (err) {
    logger.warn('screening persist/eval absorb (application unaffected)', {
      application_id: applicationId,
      ...(err instanceof Error ? { error: err.message } : {}),
    })
    return null
  }
}

// ── Owner-side reads (docs/05 §4.10) ─────────────────────────────────────────

export interface AnswerView {
  question_id: string
  label: string | null // null when the question was edited away after answering
  type: QuestionValue['type'] | null
  answer: unknown
}

/** Answers for one application — scope verified via the parent job (404 semantics). */
export async function listAnswersForApplication(
  client: Client,
  scope: Scope,
  applicationId: string,
): Promise<{
  data: AnswerView[]
  screening_status: ScreeningStatusValue | null
  job_id: string
} | null> {
  const { data: appRow, error: appError } = await client
    .from('applications')
    .select(
      'id, job_id, screening_status, job:jobs!inner(owner_id, organization_id, screening_config)',
    )
    .eq('id', applicationId)
    .maybeSingle()
  if (appError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the application.', { cause: appError })
  if (!appRow) return null
  const app = appRow as unknown as {
    id: string
    job_id: string
    screening_status: ScreeningStatusValue | null
    job:
      | { owner_id: string; organization_id: string | null; screening_config: unknown }
      | Array<{ owner_id: string; organization_id: string | null; screening_config: unknown }>
      | null
  }
  const jobEmbed = Array.isArray(app.job) ? app.job[0] : app.job
  if (!jobEmbed || !isRowInScope(jobEmbed, scope)) return null

  const { data: rows, error } = await client
    .from('application_answers')
    .select('question_id, answer')
    .eq('application_id', applicationId)
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load the answers.', { cause: error })

  const config = parseScreeningConfig(jobEmbed.screening_config)
  const byId = new Map(config.questions.map((q) => [q.id, q]))
  const data: AnswerView[] = ((rows ?? []) as Array<{ question_id: string; answer: unknown }>).map(
    (r) => {
      const q = byId.get(r.question_id)
      return {
        question_id: r.question_id,
        label: q?.label ?? null,
        type: q?.type ?? null,
        answer: r.answer,
      }
    },
  )
  return { data, screening_status: app.screening_status, job_id: app.job_id }
}

// ── Recompute (docs/17 §4.4 — synchronous; pure function, DB-bound) ─────────

const RECOMPUTE_BATCH = 500

export async function recomputeScreening(
  client: Client,
  scope: Scope,
  jobId: string,
): Promise<{ recomputed: number; changed: number }> {
  assertCapability(scope, 'jobs.write')
  const job = await getJob(client, scope, jobId)
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')
  const config = parseScreeningConfig(job.screening_config)

  // Non-terminal applications only (17 §4.4) — verdicts for hired/rejected are frozen history.
  const { data: apps, error: appsError } = await client
    .from('applications')
    .select('id, applicant_id, screening_status')
    .eq('job_id', job.id)
    .not('status', 'in', '(hired,rejected)')
    .limit(10_000)
  if (appsError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load applications.', { cause: appsError })
  const rows = (apps ?? []) as Array<{
    id: string
    applicant_id: string
    screening_status: ScreeningStatusValue | null
  }>

  let changed = 0
  for (let start = 0; start < rows.length; start += RECOMPUTE_BATCH) {
    const batch = rows.slice(start, start + RECOMPUTE_BATCH)
    const ids = batch.map((r) => r.id)
    const { data: answerRows, error: answersError } = await client
      .from('application_answers')
      .select('application_id, question_id, answer')
      .in('application_id', ids)
    if (answersError)
      throw new AppError(ErrorCode.INTERNAL, 'Could not load answers.', { cause: answersError })

    const byApplication = new Map<string, Record<string, boolean | string | number | string[]>>()
    for (const a of (answerRows ?? []) as Array<{
      application_id: string
      question_id: string
      answer: unknown
    }>) {
      const bucket = byApplication.get(a.application_id) ?? {}
      bucket[a.question_id] = a.answer as boolean | string | number | string[]
      byApplication.set(a.application_id, bucket)
    }

    for (const app of batch) {
      const verdict = evaluateScreening(config.questions, byApplication.get(app.id) ?? {})
      const next = verdict.status
      if (next === app.screening_status) continue
      const { error: updateError } = await client
        .from('applications')
        .update({ screening_status: next })
        .eq('id', app.id)
      if (updateError) {
        logger.warn('screening recompute: row update failed (continuing)', {
          application_id: app.id,
          update_error: updateError.message,
        })
        continue
      }
      changed += 1
      await client.from('timeline_events').insert({
        owner_id: job.owner_id,
        applicant_id: app.applicant_id,
        application_id: app.id,
        actor_id: scope.ownerId,
        type: 'questionnaire_screened',
        payload: {
          verdict: next,
          failed: verdict.details.filter((d) => d.outcome === 'fail').map((d) => d.questionId),
          review: verdict.details.filter((d) => d.outcome === 'review').map((d) => d.questionId),
          source: 'recompute',
        },
      })
    }
  }
  return { recomputed: rows.length, changed }
}
