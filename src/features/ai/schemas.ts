import { z } from 'zod'
import { PROMPT_VERSIONS, SOCIAL_PLATFORMS, SOCIAL_TONES } from '@/lib/ai/prompts'

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

// ── Resume profile (parse v2 — docs/17 §6; cache table applicant_profiles) ───

export const RESUME_PROFILE_CAPS = {
  education: 5,
  employers: 8,
  skills: 30,
  tools: 15,
  projects: 5,
  summaryChars: 800,
} as const

function cappedKeywords(arr: string[], cap: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of arr) {
    const k = raw.trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
    if (out.length >= cap) break
  }
  return out
}

/** 0 ≤ v ≤ plausibility window, else null (never reject — heal). */
function saneNumber(v: number | null, max: number): number | null {
  return v !== null && Number.isFinite(v) && v >= 0 && v <= max ? v : null
}

export const ResumeProfileSchema = z.object({
  education: z
    .array(
      z.object({
        degree: z.string().catch(''),
        institution: nullableString.catch(null),
        year: nullableNumber.catch(null),
      }),
    )
    .default([])
    .transform((arr) => arr.filter((e) => e.degree.trim()).slice(0, RESUME_PROFILE_CAPS.education)),
  employers: z
    .array(
      z.object({
        name: z.string().catch(''),
        title: nullableString.catch(null),
        months: nullableNumber.catch(null),
        industry: nullableString.catch(null),
      }),
    )
    .default([])
    .transform((arr) => arr.filter((e) => e.name.trim()).slice(0, RESUME_PROFILE_CAPS.employers)),
  skills: z
    .array(z.string())
    .default([])
    .transform((arr) => cappedKeywords(arr, RESUME_PROFILE_CAPS.skills)),
  tools: z
    .array(z.string())
    .default([])
    .transform((arr) => cappedKeywords(arr, RESUME_PROFILE_CAPS.tools)),
  responsibilities_summary: z
    .string()
    .catch('')
    .transform((s) => s.trim().slice(0, RESUME_PROFILE_CAPS.summaryChars)),
  total_experience_years: nullableNumber.catch(null).transform((v) => saneNumber(v, 60)),
  location: nullableString.catch(null),
  /** CTC only ever appears when explicitly stated on the resume (prompt discipline, 17 §6). */
  current_ctc: nullableNumber.catch(null).transform((v) => saneNumber(v, 1_000_000_000_000)),
  expected_ctc: nullableNumber.catch(null).transform((v) => saneNumber(v, 1_000_000_000_000)),
  notice_period: nullableString.catch(null),
  projects: z
    .array(
      z.object({
        name: z.string().catch(''),
        summary: nullableString.catch(null),
      }),
    )
    .default([])
    .transform((arr) => arr.filter((p) => p.name.trim()).slice(0, RESUME_PROFILE_CAPS.projects)),
})
export type ResumeProfile = z.infer<typeof ResumeProfileSchema>

/** Gemini responseSchema for the profile contract (docs/10 §4). Pure data, unit-tested. */
export const RESUME_PROFILE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  properties: {
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
    employers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          title: { type: 'STRING', nullable: true },
          months: { type: 'NUMBER', nullable: true },
          industry: { type: 'STRING', nullable: true },
        },
        required: ['name'],
      },
    },
    skills: { type: 'ARRAY', items: { type: 'STRING' } },
    tools: { type: 'ARRAY', items: { type: 'STRING' } },
    responsibilities_summary: { type: 'STRING' },
    total_experience_years: { type: 'NUMBER', nullable: true },
    location: { type: 'STRING', nullable: true },
    current_ctc: { type: 'NUMBER', nullable: true },
    expected_ctc: { type: 'NUMBER', nullable: true },
    notice_period: { type: 'STRING', nullable: true },
    projects: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          summary: { type: 'STRING', nullable: true },
        },
        required: ['name'],
      },
    },
  },
  required: ['education', 'employers', 'skills', 'tools', 'responsibilities_summary', 'projects'],
}

/**
 * Cache rule (docs/17 §6): refreshed ONLY when a newer uploaded resume exists
 * or the prompt version changed — never re-parsed needlessly. "No resume" is
 * not staleness (nothing to build from).
 */
export function profileStale(
  stored: { source_resume_id: string | null; prompt_version: string } | null,
  latestResumeId: string | null,
): boolean {
  if (!latestResumeId) return false
  if (!stored) return true
  return (
    stored.source_resume_id !== latestResumeId ||
    stored.prompt_version !== PROMPT_VERSIONS.profile_extract
  )
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

/** No force flag: staleness (newer resume / prompt version) drives refresh (17 §6). */
export const ApplicantProfileInput = z.object({ applicant_id: z.string().uuid() }).strict()

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
