import 'server-only'

/**
 * AIProvider contract — docs/03 §4 + docs/10 §2. Nothing outside lib/ai/
 * imports a provider SDK or endpoint; features/services consume this seam.
 * D4-style: results are unions; providers never throw across the seam.
 */

export type AiFeature =
  'parse_resume' | 'profile_extract' | 'summarize' | 'jd_draft' | 'social_post'

export const AI_CAPABILITIES: readonly AiFeature[] = [
  'parse_resume',
  'profile_extract',
  'summarize',
  'jd_draft',
  'social_post',
] as const

export interface AiGenerateRequest {
  system?: string | undefined
  prompt: string
  temperature: number
  maxOutputTokens: number
  /** Structured output (docs/10 §4): response_mime_type=application/json + responseSchema. */
  jsonSchema?: Record<string, unknown> | undefined
}

export type AiGenerateResult =
  | {
      ok: true
      text: string
      inputTokens: number | null
      outputTokens: number | null
    }
  | {
      ok: false
      code: string
      retryable: boolean
      /** True for invalid/revoked keys — flips integration status='error' + banner. */
      integrationBroken: boolean
      status: number | null
      /** Log-only detail; never user-facing. */
      detail?: string | undefined
    }

export interface AIProvider {
  readonly name: 'gemini'
  readonly model: string
  readonly capabilities: readonly AiFeature[]
  /** Minimal 1-token ping used at connect time (docs/10 §1). */
  verifyKey(): Promise<AiGenerateResult>
  generate(req: AiGenerateRequest): Promise<AiGenerateResult>
}
