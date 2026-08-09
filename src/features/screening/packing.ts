import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger, errorSummary } from '@/lib/logger'
import type { ResumeProfile } from '@/features/ai/schemas'
import type { AnswerScalar, QuestionValue } from '@/features/screening/schemas'
import { describeRule, type ScreeningResultCore } from '@/features/screening/session-schemas'

/**
 * Candidate-context packing + per-row result writes (docs/17 §9.2 — packed per
 * chunk for interactive, per candidate for Batch). Shared by process.ts and
 * batch-session.ts (writeSingleResult lives HERE so those two engines never
 * import each other).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

export const RESUME_EXCERPT_CHARS = 1200
export const JOB_DESCRIPTION_CHARS = 800
/** packCandidates batches its three queries at this id count (URL-safe). */
export const PACK_ID_CHUNK = 100

export interface PendingRow {
  id: string
  application_id: string
  applicant_id: string
}

export interface PackedCandidate {
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

/** ids must already respect PACK_ID_CHUNK (PostgREST URL safety). */
export async function packCandidates(
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

/**
 * Writes one candidate's verdict onto its result row (17 §9.3 retry unit).
 * `result: null` marks the row failed with an actionable message — a row
 * failure NEVER sinks a session.
 */
export async function writeSingleResult(
  client: Client,
  rowId: string,
  result: ScreeningResultCore | null,
  failMessage?: string,
): Promise<boolean> {
  const patch = result
    ? {
        status: 'ok',
        category: result.category,
        rank: result.rank,
        score: result.score,
        reasons: result.reasons,
        evidence: result.evidence,
        uncertainties: result.uncertainties,
      }
    : { status: 'failed', error: (failMessage ?? 'AI error').slice(0, 200) }
  const { error } = await client.from('ai_screening_results').update(patch).eq('id', rowId)
  if (error) {
    logger.warn('screening row write failed', { ...errorSummary(error) })
    return false
  }
  return true
}

/** All pending rows for a session, paged (batch submits the whole pool at once). */
export async function loadAllPendingRows(client: Client, sessionId: string): Promise<PendingRow[]> {
  const out: PendingRow[] = []
  const PAGE = 200
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('ai_screening_results')
      .select('id, application_id, applicant_id')
      .eq('session_id', sessionId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const page = (data ?? []) as PendingRow[]
    out.push(...page)
    if (page.length < PAGE) return out
  }
}
