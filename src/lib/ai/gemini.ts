import 'server-only'

import { logger } from '@/lib/logger'
import {
  AI_CAPABILITIES,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AIProvider,
} from '@/lib/ai/types'

/**
 * Gemini provider — docs/10 §2/§4. Plain REST against v1beta generateContent:
 * no SDK dep keeps the tiny-box build light (same posture as docs/12 §8).
 * `fetchImpl` is injectable so the whole surface is unit-testable offline.
 */

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_MODEL = 'gemini-2.0-flash' // docs/10 §2 default
const TIMEOUT_MS = 30_000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Pure request-shape builder (unit-tested) — docs/10 §4 structured output. */
export function buildGenerateContentBody(req: AiGenerateRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
  }
  if (req.jsonSchema) {
    generationConfig.responseMimeType = 'application/json'
    generationConfig.responseSchema = req.jsonSchema
  }
  return {
    contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    generationConfig,
  }
}

interface GeminiPart {
  text?: string
}
interface GeminiResponseBody {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { message?: string; status?: string }
}

function mapFailure(status: number, body: GeminiResponseBody | null): AiGenerateResult {
  const detail = body?.error?.message ?? `HTTP ${status}`
  const statusLabel = body?.error?.status ?? ''
  const keyRejected =
    status === 401 ||
    status === 403 ||
    (status === 400 &&
      /API key|API_KEY_INVALID|PERMISSION_DENIED/i.test(`${detail} ${statusLabel}`))
  if (keyRejected) {
    return {
      ok: false,
      code: 'ai_key_rejected',
      retryable: false,
      integrationBroken: true,
      status,
      detail,
    }
  }
  if (status === 429) {
    return {
      ok: false,
      code: 'ai_rate_limited',
      retryable: true,
      integrationBroken: false,
      status,
      detail,
    }
  }
  const retryable = status >= 500
  return {
    ok: false,
    code: retryable ? 'ai_unavailable' : 'ai_request_failed',
    retryable,
    integrationBroken: false,
    status,
    detail,
  }
}

export function makeGeminiProvider(options: {
  apiKey: string
  model?: string
  fetchImpl?: FetchLike
  baseUrl?: string
}): AIProvider {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = options.baseUrl ?? DEFAULT_BASE
  const model = options.model ?? DEFAULT_MODEL

  async function call(body: Record<string, unknown>): Promise<AiGenerateResult> {
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Key in header, never in URL — keeps it out of access/URL logs (docs/10 §1).
          'x-goog-api-key': options.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError'
      return {
        ok: false,
        code: timeout ? 'ai_timeout' : 'ai_network',
        retryable: true,
        integrationBroken: false,
        status: null,
      }
    }

    const json = (await res.json().catch(() => null)) as GeminiResponseBody | null
    if (!res.ok) return mapFailure(res.status, json)

    const text = (json?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim()
    return {
      ok: true,
      text,
      inputTokens: json?.usageMetadata?.promptTokenCount ?? null,
      outputTokens: json?.usageMetadata?.candidatesTokenCount ?? null,
    }
  }

  return {
    name: 'gemini',
    model,
    capabilities: AI_CAPABILITIES,

    /** docs/10 §1: verify with a minimal 1-token generateContent call. */
    verifyKey() {
      return call(
        buildGenerateContentBody({
          prompt: 'Reply with the word: ok',
          temperature: 0,
          maxOutputTokens: 1,
        }),
      )
    },

    async generate(req) {
      const result = await call(buildGenerateContentBody(req))
      if (result.ok) {
        // Per-call token counts: dev logs only, never PII (docs/10 §7).
        logger.info('ai generate', {
          model,
          input_tokens: result.inputTokens,
          output_tokens: result.outputTokens,
        })
      }
      return result
    },
  }
}

/** Vertex/Gemini returns JSON sometimes fenced or padded — extract it tolerantly. */
export function tolerantJsonParse(raw: string): unknown | null {
  const candidates = [raw, raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')]
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim())
    } catch {
      // try next form
    }
  }
  // Last resort: first { … last }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return null
    }
  }
  return null
}
