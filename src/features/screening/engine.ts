import {
  EDUCATION_LEVELS,
  type EducationLevelValue,
  type QuestionValue,
  type RuleValue,
  type ScreeningStatusValue,
} from '@/features/screening/schemas'

/**
 * Deterministic screening engine — docs/17 §4 (normative).
 * PURE: no DB, no framework, no AI. 100% branch coverage is enforced by
 * tests/screening-engine.test.ts (13 Phase-5). The safety rail (§4.3):
 * rejection requires a CLEAR, parseable answer that fails a rule —
 * anything missing/ambiguous/marked unclear is `review_required`, never a rejection.
 */

export type RuleOutcome = 'pass' | 'fail' | 'review'

export interface RuleEval {
  questionId: string
  outcome: RuleOutcome
}

export interface ScreeningVerdict {
  /** null = no mandatory questions configured (job screens nothing). */
  status: ScreeningStatusValue | null
  details: RuleEval[]
}

type Answer = boolean | string | number | string[]

function isEmptyish(value: Answer | undefined): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  )
}

function evaluateRule(q: QuestionValue, rule: RuleValue, answer: Answer | undefined): RuleOutcome {
  if (isEmptyish(answer)) return 'review'

  switch (rule.op) {
    case 'eq': {
      // yes_no / relocate — answer must be boolean
      if (typeof answer !== 'boolean') return 'review'
      return answer === rule.value ? 'pass' : 'fail'
    }
    case 'in':
    case 'not_in': {
      // single_choice / dropdown — answer must be a known option string
      if (typeof answer !== 'string') return 'review'
      if (!(q.options ?? []).includes(answer)) return 'review' // unknown option → tampered/stale
      const member = rule.values.includes(answer)
      return rule.op === 'in' ? (member ? 'pass' : 'fail') : member ? 'fail' : 'pass'
    }
    case 'includes_all':
    case 'includes_any':
    case 'includes_none': {
      // multiple_choice — answer must be an array of known options
      if (!Array.isArray(answer) || answer.some((v) => typeof v !== 'string')) return 'review'
      const opts = new Set(q.options ?? [])
      if (answer.some((v) => !opts.has(v))) return 'review'
      const picks = new Set(answer as string[])
      if (rule.op === 'includes_all') {
        return rule.values.every((v) => picks.has(v)) ? 'pass' : 'fail'
      }
      if (rule.op === 'includes_any') {
        return rule.values.some((v) => picks.has(v)) ? 'pass' : 'fail'
      }
      return rule.values.every((v) => !picks.has(v)) ? 'pass' : 'fail'
    }
    case 'min':
    case 'max':
    case 'range': {
      if (typeof answer !== 'number' || !Number.isFinite(answer)) return 'review'
      if (rule.op === 'min') return answer >= rule.value ? 'pass' : 'fail'
      if (rule.op === 'max') return answer <= rule.value ? 'pass' : 'fail'
      if (rule.min !== undefined && answer < rule.min) return 'fail'
      if (rule.max !== undefined && answer > rule.max) return 'fail'
      return 'pass'
    }
    case 'contains_any': {
      if (typeof answer !== 'string' || answer.trim() === '') return 'review'
      const hay = answer.toLowerCase()
      return rule.keywords.some((k) => hay.includes(k.toLowerCase())) ? 'pass' : 'fail'
    }
    case 'not_empty': {
      return typeof answer === 'string' && answer.trim().length > 0 ? 'pass' : 'review'
    }
    case 'min_level': {
      if (typeof answer !== 'string') return 'review'
      const given = EDUCATION_LEVELS.indexOf(answer as EducationLevelValue)
      if (given === -1) return 'review'
      return given >= EDUCATION_LEVELS.indexOf(rule.level) ? 'pass' : 'fail'
    }
  }
}

/**
 * Computes the job's verdict for one application (docs/17 §4.2).
 * Aggregate: any `fail` → does_not_meet_mandatory; else any `review` →
 * review_required; else qualified. No mandatory questions → status null.
 */
export function evaluateScreening(
  questions: QuestionValue[],
  answers: Record<string, Answer | undefined>,
): ScreeningVerdict {
  const mandatory = questions.filter((q) => q.classification === 'mandatory' && q.rule)
  if (mandatory.length === 0) return { status: null, details: [] }

  const details: RuleEval[] = mandatory.map((q) => ({
    questionId: q.id,
    // q.rule is guaranteed by the filter above (classification==='mandatory' ⊃ rule by schema)
    outcome: evaluateRule(q, q.rule as NonNullable<QuestionValue['rule']>, answers[q.id]),
  }))

  if (details.some((d) => d.outcome === 'fail')) {
    return { status: 'does_not_meet_mandatory', details }
  }
  if (details.some((d) => d.outcome === 'review')) {
    return { status: 'review_required', details }
  }
  return { status: 'qualified', details }
}
