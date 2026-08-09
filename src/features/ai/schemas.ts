import { z } from 'zod'
import { SOCIAL_PLATFORMS, SOCIAL_TONES } from '@/lib/ai/prompts'

/**
 * AI feature schemas — docs/10 §4 structured output contract + docs/05 §4.7 inputs.
 * The zod schema is the ENFORCEMENT layer after Gemini's responseSchema: model
 * output is validated (and healed on rails: slices caps, null-catches scalars)
 * before anything is cached (docs/10 §4).
 */

const nullableString = z.string().nullable().default(null)
const nullableNumber = z.number().nullable().default(null)

export const ParsedResumeSchema = z.object({
  candidate: z
    .object({
      name: nullableString,
      email: nullableString,
      phone: nullableString,
      location: nullableString,
    })
    .default({ name: null, email: null, phone: null, location: null }),
  headline: nullableString,
  skills: z
    .array(z.string())
    .default([])
    .transform((arr) =>
      [...new Set(arr.map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 15),
    ),
  experience_years: nullableNumber,
  experience: z
    .array(
      z.object({
        title: z.string().catch(''),
        company: nullableString,
        months: nullableNumber,
      }),
    )
    .default([])
    .transform((arr) => arr.slice(0, 6)),
  education: z
    .array(
      z.object({
        degree: z.string().catch(''),
        institution: nullableString,
        year: nullableNumber,
      }),
    )
    .default([])
    .transform((arr) => arr.slice(0, 3)),
  languages: z
    .array(z.string())
    .default([])
    .transform((arr) =>
      arr
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 8),
    ),
  summary: z.string().min(1),
})
export type ParsedResume = z.infer<typeof ParsedResumeSchema>

/** Gemini responseSchema for the contract above (docs/10 §4). Pure data, unit-tested. */
export const PARSED_RESUME_JSON_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    candidate: {
      type: 'OBJECT',
      properties: {
        name: { type: 'STRING', nullable: true },
        email: { type: 'STRING', nullable: true },
        phone: { type: 'STRING', nullable: true },
        location: { type: 'STRING', nullable: true },
      },
    },
    headline: { type: 'STRING', nullable: true },
    skills: { type: 'ARRAY', items: { type: 'STRING' } },
    experience_years: { type: 'NUMBER', nullable: true },
    experience: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          company: { type: 'STRING', nullable: true },
          months: { type: 'NUMBER', nullable: true },
        },
        required: ['title'],
      },
    },
    education: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          degree: { type: 'STRING' },
          institution: { type: 'STRING', nullable: true },
          year: { type: 'NUMBER', nullable: true },
        },
        required: ['degree'],
      },
    },
    languages: { type: 'ARRAY', items: { type: 'STRING' } },
    summary: { type: 'STRING' },
  },
  required: ['candidate', 'skills', 'experience', 'education', 'languages', 'summary'],
}

export const SummaryOutputSchema = z.object({
  summary: z.string().min(1),
  strengths: z
    .array(z.string())
    .min(1)
    .transform((arr) =>
      arr
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3),
    ),
})
export type SummaryOutput = z.infer<typeof SummaryOutputSchema>

export const SUMMARY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    strengths: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'strengths'],
}

/** applicants.ai_summary is a TEXT column — shape is JSON-encoded cache. */
export interface CandidateSummaryCache extends SummaryOutput {
  generated_at: string
  model: string
}
export function encodeSummaryCache(cache: CandidateSummaryCache): string {
  return JSON.stringify(cache)
}
export function decodeSummaryCache(raw: string | null): CandidateSummaryCache | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const output = SummaryOutputSchema.safeParse(parsed)
    if (!output.success) return null
    return {
      ...output.data,
      generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : '',
      model: typeof parsed.model === 'string' ? parsed.model : 'gemini-2.0-flash',
    }
  } catch {
    return null
  }
}

// ── Endpoint inputs (docs/05 §4.7) ─────────────────────────────────────────────

export const ConnectAiInput = z
  .object({
    api_key: z.string().trim().min(10, 'That key looks too short').max(200),
  })
  .strict()

export const ParseResumeInput = z.object({ resume_id: z.string().uuid() }).strict()

/** force=true regenerates over the cache (docs/10 §3 "Re-generate allowed"). */
export const SummarizeApplicantInput = z
  .object({
    applicant_id: z.string().uuid(),
    force: z.boolean().default(false),
  })
  .strict()

export const GenerateJobDescriptionInput = z
  .object({
    title: z.string().trim().min(3).max(120),
    notes: z.string().max(2000).optional(),
  })
  .strict()

export const GenerateSocialPostInput = z
  .object({
    job_id: z.string().uuid(),
    tone: z.enum(SOCIAL_TONES).default('friendly'),
    platform: z.enum(SOCIAL_PLATFORMS).default('whatsapp'),
  })
  .strict()
