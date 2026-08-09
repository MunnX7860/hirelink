import 'server-only'

import { logger } from '@/lib/logger'
import { buildGenerateContentBody, tolerantJsonParse } from '@/lib/ai/gemini'
import type { AiGenerateRequest } from '@/lib/ai/types'
import {
  ScreeningResultSchema,
  type ScreeningResultCore,
} from '@/features/screening/session-schemas'

/**
 * Gemini Batch API client — docs/17 §9.2 accelerator. Same posture as the
 * interactive provider (10 §2): plain REST, no SDK, key in header never URL,
 * injectable fetch for tests, union results (D4: never throws across the seam).
 *
 * REST surface verified 2026-08-09 against ai.google.dev/gemini-api/docs/batch-api:
 *   create: POST /v1beta/models/{model}:batchGenerateContent
 *           body { batch: { display_name, input_config: { requests: { requests:
 *           [ { request: GenerateContentRequest, metadata: { key } } ] } } } }
 *   poll:   GET  /v1beta/{name}  → operation-ish resource; state at metadata.state
 *           (REST/long-running shape) OR state (newer resource shape); results at
 *           response.inlinedResponses OR dest.inlinedResponses — both normalized.
 * Batch quota is SEPARATE from interactive (no RPM/RPD burn), 24h SLO, ~50% cost.
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_MODEL = 'gemini-2.0-flash' // matches the interactive default (10 §2)
const TIMEOUT_MS = 30_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface BatchItem {
  /** Caller-side correlation key (we use the ai_screening_results row id). */
  key: string
  request: AiGenerateRequest
}

export interface BatchFailure {
  ok: false
  code: string
  retryable: boolean
  integrationBroken: boolean
  status: number | null
  detail?: string | undefined
}
export type BatchCreateResult = { ok: true; name: string } | BatchFailure

export interface BatchResponseEntry {
  key: string | null
  /** Joined text parts; null when this per-request item errored. */
  text: string | null
}
export type BatchPollResult =
  | { ok: true; done: false; succeededCount: number; failedCount: number }
  | { ok: true; done: true; succeeded: boolean; responses: BatchResponseEntry[] }
  | BatchFailure

/** Inline submissions must stay <20MB (official docs); we keep a slack buffer. */
export const BATCH_INLINE_MAX_BYTES = 15_000_000

/**
 * Salvage-first parse for ONE batch item's text (17 §8 safe rails). The row
 * correlation is the metadata key — the echoed `candidate` label is advisory,
 * so a label-only deviation is healed to the expected label and re-validated
 * (never a fabricated negative; everything else falls to null → row failed).
 * Hosted here (not session-schemas) so the CLIENT dashboard never pulls the
 * server-only Gemini module transitively.
 */
export function parseBatchItemResult(raw: string): ScreeningResultCore | null {
  const parsed = tolerantJsonParse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const first = ScreeningResultSchema.safeParse(parsed)
  if (first.success) {
    const { candidate: _label, ...core } = first.data
    return core
  }
  const relabeled = ScreeningResultSchema.safeParse({
    ...(parsed as Record<string, unknown>),
    candidate: 'C1',
  })
  if (relabeled.success) {
    const { candidate: _label, ...core } = relabeled.data
    return core
  }
  return null
}

/** Pure create-body builder (unit-tested). */
export function buildBatchCreateBody(
  items: BatchItem[],
  displayName: string,
): Record<string, unknown> {
  return {
    batch: {
      display_name: displayName,
      input_config: {
        requests: {
          requests: items.map((item) => ({
            request: buildGenerateContentBody(item.request),
            metadata: { key: item.key },
          })),
        },
      },
    },
  }
}

/** Byte-size guard so callers can fall back to JSONL/interactive before POSTing. */
export function estimateBatchBodyBytes(body: Record<string, unknown>): number {
  return JSON.stringify(body).length
}

// ── Poll-resource normalization (both documented surface variants) ───────────

interface RawGeminiPart {
  text?: string
}
interface RawGeminiResponse {
  candidates?: Array<{ content?: { parts?: RawGeminiPart[] } }>
}
interface RawInlineResponse {
  metadata?: { key?: string }
  response?: RawGeminiResponse
  error?: unknown
}
interface RawBatchStats {
  successCount?: number | string
  failedCount?: number | string
  succeededRequestCount?: number | string
  failedRequestCount?: number | string
}
interface RawBatchResource {
  name?: string
  state?: string
  metadata?: { state?: string; batchStats?: RawBatchStats }
  response?: { inlinedResponses?: RawInlineResponse[]; responsesFile?: string }
  dest?: { inlinedResponses?: RawInlineResponse[]; fileName?: string }
  error?: { message?: string }
}

const DONE_STATES = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
])

function toCount(v: number | string | undefined): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/** Tolerant normalizer across the two documented REST shapes (unit-tested). */
export function normalizeBatchResource(raw: RawBatchResource): {
  state: string
  done: boolean
  succeededCount: number
  failedCount: number
  succeeded: boolean
  responses: BatchResponseEntry[]
} {
  const state = raw.metadata?.state ?? raw.state ?? 'JOB_STATE_PENDING'
  const stats = raw.metadata?.batchStats
  const succeededCount = toCount(stats?.successCount ?? stats?.succeededRequestCount)
  const failedCount = toCount(stats?.failedCount ?? stats?.failedRequestCount)
  const done = DONE_STATES.has(state)
  const succeeded = state === 'JOB_STATE_SUCCEEDED'
  const inline = raw.response?.inlinedResponses ?? raw.dest?.inlinedResponses ?? []
  if (done && succeeded && (raw.response?.responsesFile ?? raw.dest?.fileName)) {
    // We only ever create INLINE batches; a file destination is not expected.
    logger.warn('batch returned a results file — file mode is not implemented (inline-only)')
  }
  return {
    state,
    done,
    succeededCount,
    failedCount,
    succeeded,
    responses: inline.map((r) => ({
      key: r.metadata?.key ?? null,
      text: r.response
        ? (r.response.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? '')
            .join('')
            .trim()
        : null,
    })),
  }
}

function failure(
  code: string,
  retryable: boolean,
  integrationBroken: boolean,
  status: number | null,
  detail?: string,
): BatchFailure {
  return { ok: false, code, retryable, integrationBroken, status, detail }
}

function mapHttpFailure(status: number, detail: string): BatchFailure {
  const keyRejected = status === 401 || status === 403
  if (keyRejected) return failure('ai_key_rejected', false, true, status, detail)
  if (status === 429) return failure('ai_rate_limited', true, false, status, detail)
  // 400-class on batch endpoints almost always means "this model/key can't batch"
  // → caller falls back to the interactive engine (17 §9.2).
  const retryable = status >= 500
  return failure(
    status >= 500 ? 'ai_unavailable' : 'ai_batch_unsupported',
    retryable,
    false,
    status,
    detail,
  )
}

export function makeBatchClient(options: {
  apiKey: string
  model?: string
  fetchImpl?: FetchLike
  baseUrl?: string
}): {
  createBatch(items: BatchItem[], displayName: string): Promise<BatchCreateResult>
  pollBatch(name: string): Promise<BatchPollResult>
  cancelBatch(name: string): Promise<void>
} {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? DEFAULT_BASE
  const model = options.model ?? DEFAULT_MODEL

  function resourceUrl(name: string): string {
    return `${baseUrl}/${name.startsWith('batches/') ? name : `batches/${name}`}`
  }

  async function rawFetch(url: string, init?: RequestInit): Promise<Response | null> {
    try {
      return await fetchImpl(url, {
        ...init,
        headers: {
          'content-type': 'application/json',
          // Key in header, never in URL — docs/10 §1.
          'x-goog-api-key': options.apiKey,
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return null
    }
  }

  return {
    async createBatch(items, displayName) {
      const body = buildBatchCreateBody(items, displayName)
      const res = await rawFetch(`${baseUrl}/models/${model}:batchGenerateContent`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (!res) return failure('ai_network', true, false, null)
      const json = (await res.json().catch(() => null)) as {
        name?: string
        error?: { message?: string }
      } | null
      if (!res.ok) return mapHttpFailure(res.status, json?.error?.message ?? `HTTP ${res.status}`)
      if (!json?.name)
        return failure(
          'ai_batch_unsupported',
          false,
          false,
          res.status,
          'no batch name in response',
        )
      logger.info('ai batch created', { batch: json.name, items: items.length, model })
      return { ok: true, name: json.name }
    },

    async pollBatch(name) {
      const res = await rawFetch(resourceUrl(name), { method: 'GET' })
      if (!res) return failure('ai_network', true, false, null)
      const json = (await res.json().catch(() => null)) as RawBatchResource | null
      if (!res.ok) {
        return mapHttpFailure(
          res.status,
          json?.error?.message ?? `HTTP ${res.status}`,
        ) as BatchPollResult
      }
      const norm = normalizeBatchResource(json ?? {})
      if (!norm.done) {
        return {
          ok: true,
          done: false,
          succeededCount: norm.succeededCount,
          failedCount: norm.failedCount,
        }
      }
      return { ok: true, done: true, succeeded: norm.succeeded, responses: norm.responses }
    },

    /** Best-effort remote cancel (used by the local cancel endpoint). */
    async cancelBatch(name) {
      try {
        await rawFetch(`${resourceUrl(name)}:cancel`, { method: 'POST', body: '{}' })
      } catch (err) {
        logger.warn('batch remote cancel failed (absorbed)', {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
