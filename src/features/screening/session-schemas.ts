import { z } from 'zod'
import { truncateWords } from '@/lib/ai/prompts'
import { EDUCATION_LABELS, type RuleValue } from '@/features/screening/schemas'

/**
 * AI Screening Sessions — schemas + pure helpers (docs/17 §7–§8; routes per
 * docs/05 §4.10). The zod contract is the enforcement layer after Gemini's
 * responseSchema; healing follows the safe rail — anything broken becomes
 * review_required/empty, NEVER a fabricated negative judgment.
 */

export const SCREENING_POOLS = [
  'qualified',
  'review_required',
  'qualified_review',
  'all_non_archived',
] as const
export const ScreeningPool = z.enum(SCREENING_POOLS)
export type ScreeningPoolValue = z.infer<typeof ScreeningPool>

export const RESULT_CATEGORIES = [
  'strong_match',
  'possible_match',
  'review_required',
  'lower_priority',
] as const
export const ResultCategory = z.enum(RESULT_CATEGORIES)
export type ResultCategoryValue = z.infer<typeof ResultCategory>

/** docs/17 §8.1 — rendered in the UI as \"Not clear from resume\". */
export const INSUFFICIENT_EVIDENCE = 'INSUFFICIENT_EVIDENCE'

export const SESSION_STATUSES = [
  'queued',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'quota_limited',
] as const
export type SessionStatusValue = (typeof SESSION_STATUSES)[number]

// ── Create-session input (05 §4.10) ───────────────────────────────────────────

export const MAX_INSTRUCTION_CHARS = 2000
export const MAX_RESULTS_CAP = 100

export const CreateSessionInput = z
  .object({
    job_id: z.string().uuid(),
    pool: ScreeningPool.default('qualified'),
    instruction: z
      .string()
      .trim()
      .min(3, 'Tell the AI what to look for (a few words is enough)')
      .max(MAX_INSTRUCTION_CHARS),
    max_results: z.number().int().min(1).max(MAX_RESULTS_CAP),
  })
  .strict()
export type CreateSessionInputValue = z.infer<typeof CreateSessionInput>

// ── Screening result contract (17 §8) ─────────────────────────────────────────

export const SCREEN_CHUNK_SIZE = 8

function clipList(cap: number, wordsCap: number) {
  return (arr: string[]): string[] =>
    arr
      .map((s) => truncateWords(s.trim(), wordsCap))
      .filter(Boolean)
      .slice(0, cap)
}

function clampScore(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null
  return Math.min(100, Math.max(0, Math.round(v)))
}

export const ScreeningResultSchema = z.object({
  /** Anonymous candidate label echoed back (C1…C8) — mapped server-side (17 §8.2.0). */
  candidate: z
    .string()
    .trim()
    .regex(/^C\d{1,3}$/),
  /** Safe-rail heal: an unknown category becomes review_required, never a real negative. */
  category: ResultCategory.catch('review_required'),
  rank: z.number().int().min(1).max(10_000).nullable().default(null).catch(null),
  /** AI prioritization score (17 §8.1) — clamped int 0–100, garbage → null. */
  score: z.number().nullable().default(null).catch(null).transform(clampScore),
  reasons: z.array(z.string()).default([]).transform(clipList(5, 20)),
  evidence: z.array(z.string()).default([]).transform(clipList(5, 30)),
  uncertainties: z.array(z.string()).default([]).transform(clipList(3, 24)),
})
export type ScreeningResultValue = z.infer<typeof ScreeningResultSchema>
/** Result minus the advisory label — the write unit (batch correlates by metadata key). */
export type ScreeningResultCore = Omit<ScreeningResultValue, 'candidate'>

/** One chunked call's output (≤SCREEN_CHUNK_SIZE results; over-production is sliced). */
export const ScreeningChunkOutput = z.object({
  results: z.array(ScreeningResultSchema).transform((arr) => arr.slice(0, SCREEN_CHUNK_SIZE)),
})
export type ScreeningChunkOutputValue = z.infer<typeof ScreeningChunkOutput>

/** Gemini responseSchema mirror of the chunk contract (docs/10 §4). */
export const SCREENING_CHUNK_JSON_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          candidate: { type: 'STRING' },
          category: {
            type: 'STRING',
            enum: [...RESULT_CATEGORIES],
          },
          rank: { type: 'NUMBER', nullable: true },
          score: { type: 'NUMBER', nullable: true },
          reasons: { type: 'ARRAY', items: { type: 'STRING' } },
          evidence: { type: 'ARRAY', items: { type: 'STRING' } },
          uncertainties: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['candidate', 'category'],
      },
    },
  },
  required: ['results'],
}

// ── Rule → plain-language expectation (17 §7 "incl. preferred answers") ──────

export function describeRule(rule: RuleValue): string {
  switch (rule.op) {
    case 'eq':
      return rule.value ? 'answer must be Yes' : 'answer must be No'
    case 'in':
      return `one of: ${rule.values.join(', ')}`
    case 'not_in':
      return `not any of: ${rule.values.join(', ')}`
    case 'includes_all':
      return `must include all of: ${rule.values.join(', ')}`
    case 'includes_any':
      return `must include at least one of: ${rule.values.join(', ')}`
    case 'includes_none':
      return `must not include any of: ${rule.values.join(', ')}`
    case 'min':
      return `at least ${rule.value}`
    case 'max':
      return `at most ${rule.value}`
    case 'range': {
      if (rule.min !== undefined && rule.max !== undefined)
        return `between ${rule.min} and ${rule.max}`
      if (rule.min !== undefined) return `at least ${rule.min}`
      return `at most ${rule.max ?? ''}`
    }
    case 'contains_any':
      return `mentions one of: ${rule.keywords.join(', ')}`
    case 'not_empty':
      return 'answered'
    case 'min_level':
      return `at least ${EDUCATION_LABELS[rule.level]}`
  }
}

// ── Pool → applications filter (session create, 17 §7) ───────────────────────

export type PoolFilter =
  { kind: 'screening'; statuses: Array<'qualified' | 'review_required'> } | { kind: 'not_archived' }

export function poolApplicationsFilter(pool: ScreeningPoolValue): PoolFilter {
  switch (pool) {
    case 'qualified':
      return { kind: 'screening', statuses: ['qualified'] }
    case 'review_required':
      return { kind: 'screening', statuses: ['review_required'] }
    case 'qualified_review':
      return { kind: 'screening', statuses: ['qualified', 'review_required'] }
    case 'all_non_archived':
      return { kind: 'not_archived' }
  }
}

// ── Result grouping + top-N display contract (17 §7 locked semantics) ────────

export interface DisplayResultRow {
  applicationId: string
  applicantId: string
  applicantName: string
  status: 'pending' | 'ok' | 'failed'
  error: string | null
  category: ResultCategoryValue | null
  rank: number | null
  score: number | null
  reasons: string[]
  evidence: string[]
  uncertainties: string[]
}

function byRankThenScore(a: DisplayResultRow, b: DisplayResultRow): number {
  const ra = a.rank ?? Number.POSITIVE_INFINITY
  const rb = b.rank ?? Number.POSITIVE_INFINITY
  if (ra !== rb) return ra - rb
  return (b.score ?? -1) - (a.score ?? -1)
}

export interface GroupedSessionResults {
  /** strong+possible flattened, ordered; sliced to max_results (top-N is an UPPER BOUND). */
  shortlist: DisplayResultRow[]
  /** Ranked rows beyond top-N when the model over-returns (still visible, never hidden). */
  beyondTopN: DisplayResultRow[]
  review_required: DisplayResultRow[]
  lower_priority: DisplayResultRow[]
  pendingCount: number
  failed: DisplayResultRow[]
}

export function groupResultsForDisplay(
  rows: DisplayResultRow[],
  maxResults: number,
): GroupedSessionResults {
  const ok = rows.filter((r) => r.status === 'ok')
  const ranked = ok
    .filter((r) => r.category === 'strong_match' || r.category === 'possible_match')
    .sort(byRankThenScore)
  return {
    shortlist: ranked.slice(0, maxResults),
    beyondTopN: ranked.slice(maxResults),
    review_required: ok.filter((r) => r.category === 'review_required').sort(byRankThenScore),
    lower_priority: ok.filter((r) => r.category === 'lower_priority').sort(byRankThenScore),
    pendingCount: rows.filter((r) => r.status === 'pending').length,
    failed: rows.filter((r) => r.status === 'failed'),
  }
}

/** 409 rule (05 §4.10): one ACTIVE session per job. */
export function isActiveSessionStatus(status: string): boolean {
  return status === 'queued' || status === 'processing'
}

// ── Stage 5.4 — async processing guards (17 §9) ──────────────────────────────

/** Batch accelerator kicks in at this pool size (17 §9.2). */
export const BATCH_POOL_THRESHOLD = 50
/** Processing lease: a crashed run is reclaimed after this window. */
export const CLAIM_EXPIRY_MS = 10 * 60_000
/** quota_limited auto-resume cooldown ("next tick" + jitter buffer, 17 §9.2). */
export const QUOTA_COOLDOWN_MS = 2 * 60_000

/**
 * Single-processor guard (17 §9.1): may an advancer (after()-kick, cron worker,
 * advance-on-view) CAS-claim this session now? Pure predicate, JS-side of the
 * compare-and-swap in process.ts.
 */
export function isLeaseClaimable(status: string, lockedAt: string | null, nowMs: number): boolean {
  if (!lockedAt) return status !== 'cancelled' && status !== 'completed' && status !== 'failed'
  const lockedMs = Date.parse(lockedAt)
  if (Number.isNaN(lockedMs)) return true
  if (status === 'quota_limited') return lockedMs + QUOTA_COOLDOWN_MS <= nowMs
  if (status === 'queued' || status === 'processing') return lockedMs + CLAIM_EXPIRY_MS <= nowMs
  return false
}

/** Retry re-queues failed rows and revives a terminal session (05 §4.10). */
export function canRetrySession(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** Cancel only ever touches sessions in flight (05 §4.10). */
export function canCancelSession(status: string): boolean {
  return status === 'queued' || status === 'processing' || status === 'quota_limited'
}

/** Should this pending volume accelerate via Gemini Batch? (17 §9.2) */
export function shouldUpgradeToBatch(engine: string, poolSize: number): boolean {
  return engine !== 'batch' && poolSize >= BATCH_POOL_THRESHOLD
}

/** Gemini responseSchema for ONE candidate's result (batch per-candidate items, 17 §9.2). */
export const SCREENING_RESULT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    candidate: { type: 'STRING' },
    category: { type: 'STRING', enum: [...RESULT_CATEGORIES] },
    rank: { type: 'NUMBER', nullable: true },
    score: { type: 'NUMBER', nullable: true },
    reasons: { type: 'ARRAY', items: { type: 'STRING' } },
    evidence: { type: 'ARRAY', items: { type: 'STRING' } },
    uncertainties: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['candidate', 'category'],
}
