import { z } from 'zod'

/**
 * Screening questionnaire schemas — docs/17 §3 (normative shapes).
 * Shared client/server. The `rule` + `classification` fields are PRIVATE:
 * only ever project through `sanitizeQuestions()` toward public surfaces.
 */

export const QUESTION_TYPES = [
  'yes_no',
  'single_choice',
  'multiple_choice',
  'dropdown',
  'text',
  'number',
  'education',
  'experience_years',
  'location',
  'current_ctc',
  'expected_ctc',
  'relocate',
] as const
export const QuestionType = z.enum(QUESTION_TYPES)
export type QuestionTypeValue = z.infer<typeof QuestionType>

export const QUESTION_CLASSES = ['mandatory', 'preferred', 'informational'] as const
export const QuestionClass = z.enum(QUESTION_CLASSES)
export type QuestionClassValue = z.infer<typeof QuestionClass>

export const SCREENING_STATUSES = [
  'qualified',
  'does_not_meet_mandatory',
  'review_required',
] as const
export const ScreeningStatus = z.enum(SCREENING_STATUSES)
export type ScreeningStatusValue = z.infer<typeof ScreeningStatus>

export const EDUCATION_LEVELS = [
  'high_school',
  'diploma',
  'bachelors',
  'masters',
  'doctorate',
] as const
export const EducationLevel = z.enum(EDUCATION_LEVELS)
export type EducationLevelValue = z.infer<typeof EducationLevel>

/** ui display order for the education ladder (engine compares by index). */
export const EDUCATION_LABELS: Record<EducationLevelValue, string> = {
  high_school: 'High school',
  diploma: 'Diploma',
  bachelors: "Bachelor's",
  masters: "Master's",
  doctorate: 'Doctorate',
}

// ── Rules (docs/17 §4.1 — operator sets per type, validated below) ───────────

const RuleBase = z.discriminatedUnion('op', [
  z.object({ op: z.literal('eq'), value: z.boolean() }),
  z.object({ op: z.literal('in'), values: z.array(z.string()).min(1).max(12) }),
  z.object({ op: z.literal('not_in'), values: z.array(z.string()).min(1).max(12) }),
  z.object({ op: z.literal('includes_all'), values: z.array(z.string()).min(1).max(12) }),
  z.object({ op: z.literal('includes_any'), values: z.array(z.string()).min(1).max(12) }),
  z.object({ op: z.literal('includes_none'), values: z.array(z.string()).min(1).max(12) }),
  z.object({ op: z.literal('min'), value: z.number().finite() }),
  z.object({ op: z.literal('max'), value: z.number().finite() }),
  z.object({
    op: z.literal('range'),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }),
  z.object({
    op: z.literal('contains_any'),
    keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
  }),
  z.object({ op: z.literal('not_empty') }),
  z.object({ op: z.literal('min_level'), level: EducationLevel }),
])
// range needs ≥1 bound — validated here (a .refine() on the option would wrap it in
// ZodEffects and break the discriminated union in zod v3).
export const Rule = RuleBase.superRefine((r, ctx) => {
  if (r.op === 'range' && r.min === undefined && r.max === undefined) {
    ctx.addIssue({ code: 'custom', path: ['min'], message: 'range needs a bound' })
  }
})
export type RuleValue = z.infer<typeof RuleBase>

const RULE_OPS_BY_TYPE: Record<QuestionTypeValue, ReadonlySet<RuleValue['op']>> = {
  yes_no: new Set(['eq']),
  relocate: new Set(['eq']),
  single_choice: new Set(['in', 'not_in']),
  dropdown: new Set(['in', 'not_in']),
  multiple_choice: new Set(['includes_all', 'includes_any', 'includes_none']),
  number: new Set(['min', 'max', 'range']),
  experience_years: new Set(['min', 'max', 'range']),
  current_ctc: new Set(['min', 'max', 'range']),
  expected_ctc: new Set(['min', 'max', 'range']),
  text: new Set(['contains_any', 'not_empty']),
  location: new Set(['contains_any', 'not_empty']),
  education: new Set(['min_level']),
}

const CHOICE_TYPES: ReadonlySet<QuestionTypeValue> = new Set([
  'single_choice',
  'multiple_choice',
  'dropdown',
])
const OPTIONED_RULE_OPS: ReadonlySet<RuleValue['op']> = new Set([
  'in',
  'not_in',
  'includes_all',
  'includes_any',
  'includes_none',
])

const QuestionBase = z
  .object({
    id: z.string().regex(/^[a-z0-9]{6}$/, 'question id must be nanoid-6'),
    label: z.string().trim().min(3, 'Question needs at least 3 characters').max(140),
    required: z.boolean().default(true),
    type: QuestionType,
    options: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
    classification: QuestionClass.default('informational'),
    rule: Rule.optional(),
  })
  .strict()
type QuestionBaseValue = z.infer<typeof QuestionBase>

/** Shared cross-field checks (17 §3.1/§4.1) — kept in a plain fn so every
 *  variant (full question, save-input) can attach it without ZodEffects
 *  chaining problems (`.omit` etc. stay available on the bases). */
function refineQuestion(
  q: Omit<QuestionBaseValue, 'id'> & { id?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (CHOICE_TYPES.has(q.type)) {
    if (!q.options || q.options.length < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Choice questions need 2–12 options.',
      })
    } else if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique.' })
    }
  } else if (q.options !== undefined && q.options.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Only choice questions have options.',
    })
  }
  if (q.classification === 'mandatory' && !q.rule) {
    ctx.addIssue({
      code: 'custom',
      path: ['rule'],
      message: 'Mandatory questions need a qualifying rule.',
    })
  }
  if (q.classification !== 'mandatory' && q.rule) {
    ctx.addIssue({
      code: 'custom',
      path: ['rule'],
      message: 'Only mandatory questions carry rules.',
    })
  }
  if (q.rule && !RULE_OPS_BY_TYPE[q.type].has(q.rule.op)) {
    ctx.addIssue({
      code: 'custom',
      path: ['rule', 'op'],
      message: `Operator "${q.rule.op}" is not valid for ${q.type}.`,
    })
  }
  if (q.rule && OPTIONED_RULE_OPS.has(q.rule.op) && 'values' in q.rule) {
    const optionSet = new Set((q.options ?? []).map((o) => o))
    const outside = q.rule.values.filter((v) => !optionSet.has(v))
    if (outside.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rule', 'values'],
        message: 'Rule values must be chosen from the options.',
      })
    }
  }
}

export const Question = QuestionBase.superRefine(refineQuestion)
export type QuestionValue = QuestionBaseValue

export const MAX_QUESTIONS = 20

export const ScreeningConfig = z
  .object({ questions: z.array(Question).max(MAX_QUESTIONS).default([]) })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>()
    for (const [i, q] of cfg.questions.entries()) {
      if (ids.has(q.id))
        ctx.addIssue({
          code: 'custom',
          path: ['questions', i, 'id'],
          message: 'Duplicate question id.',
        })
      ids.add(q.id)
    }
  })
export type ScreeningConfigValue = z.infer<typeof ScreeningConfig>

/** Lenient parse for DB rows (never trust jsonb). */
export function parseScreeningConfig(raw: unknown): ScreeningConfigValue {
  const parsed = ScreeningConfig.safeParse(raw)
  return parsed.success ? parsed.data : { questions: [] }
}

// ── Public sanitizer (17 §3.4 — rules never leave the server) ────────────────

export const PublicQuestion = z
  .object({
    id: z.string().regex(/^[a-z0-9]{6}$/),
    label: z.string(),
    required: z.boolean(),
    type: QuestionType,
    options: z.array(z.string()).optional(),
  })
  .strict()
export type PublicQuestionValue = z.infer<typeof PublicQuestion>

/** The ONLY projection allowed toward candidates / public payloads. */
export function sanitizeQuestions(questions: QuestionValue[]): PublicQuestionValue[] {
  return questions.map((q) => ({
    id: q.id,
    label: q.label,
    required: q.required,
    type: q.type,
    ...(q.type && CHOICE_TYPES.has(q.type) ? { options: q.options ?? [] } : {}),
  }))
}

// ── Answers payload (17 §5) ──────────────────────────────────────────────────

export type AnswerScalar = boolean | string | number | string[]

export const AnswersInput = z.record(z.string(), z.unknown())
export type AnswersInputValue = z.infer<typeof AnswersInput>

export interface AnswersValidation {
  ok: boolean
  /** cleaned, typed answers keyed by question id (unknown ids dropped — 17 §5) */
  cleaned: Record<string, AnswerScalar>
  /** field errors keyed `answers.<question_id>` (envelope details, 05 §2) */
  fieldErrors: Record<string, string[]>
}

const REQUIRED_MSG = 'This question needs an answer.'

function numericLike(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.replace(/[, ₹$]/g, ''))
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Validates + types the apply payload against the job's question set.
 * Unknown ids dropped; missing required answers produce field errors.
 */
export function validateAnswers(
  questions: QuestionValue[],
  raw: AnswersInputValue,
): AnswersValidation {
  const cleaned: Record<string, AnswerScalar> = {}
  const fieldErrors: Record<string, string[]> = {}

  for (const q of questions) {
    const key = `answers.${q.id}`
    const value = raw[q.id]
    const missing = value === undefined || value === null || value === ''

    if (missing) {
      if (q.required) fieldErrors[key] = [REQUIRED_MSG]
      continue
    }

    switch (q.type) {
      case 'yes_no':
      case 'relocate': {
        const bool =
          value === true || value === 'true'
            ? true
            : value === false || value === 'false'
              ? false
              : null
        if (bool === null) fieldErrors[key] = ['Please pick yes or no.']
        else cleaned[q.id] = bool
        break
      }
      case 'single_choice':
      case 'dropdown': {
        if (typeof value !== 'string' || !(q.options ?? []).includes(value)) {
          fieldErrors[key] = ['Please pick one of the options.']
        } else cleaned[q.id] = value
        break
      }
      case 'multiple_choice': {
        const arr = Array.isArray(value)
          ? value.filter((v): v is string => typeof v === 'string')
          : null
        if (!arr || arr.length === 0 || arr.some((v) => !(q.options ?? []).includes(v))) {
          fieldErrors[key] = ['Please pick one or more of the options.']
        } else cleaned[q.id] = [...new Set(arr)]
        break
      }
      case 'number':
      case 'experience_years':
      case 'current_ctc':
      case 'expected_ctc': {
        const n = numericLike(value)
        if (n === null || n < 0 || n > 1_000_000_000_000)
          fieldErrors[key] = ['Please enter a number.']
        else cleaned[q.id] = n
        break
      }
      case 'education': {
        const parsed = EducationLevel.safeParse(value)
        if (!parsed.success) fieldErrors[key] = ['Please pick your education level.']
        else cleaned[q.id] = parsed.data
        break
      }
      case 'text':
      case 'location': {
        if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
          fieldErrors[key] = ['Please enter an answer (up to 500 characters).']
        } else cleaned[q.id] = value.trim()
        break
      }
    }
  }

  return { ok: Object.keys(fieldErrors).length === 0, cleaned, fieldErrors }
}

/** API input for saving the questionnaire (builder PUT) — ids assigned server-side. */
export const SaveQuestionInput = QuestionBase.omit({ id: true })
  .extend({
    id: z
      .string()
      .regex(/^[a-z0-9]{6}$/)
      .optional(),
  })
  .superRefine(refineQuestion)
export type SaveQuestionInputValue = z.infer<typeof SaveQuestionInput>
export const SaveScreeningConfigInput = z
  .object({ questions: z.array(SaveQuestionInput).max(MAX_QUESTIONS) })
  .strict()
export type SaveScreeningConfigInputValue = z.infer<typeof SaveScreeningConfigInput>

/** Apply-page form payload type (client-only helper type; server validates). */
export interface AnswerMap {
  [questionId: string]: AnswerScalar | undefined
}
