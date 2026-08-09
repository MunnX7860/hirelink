import { describe, it, expect } from 'vitest'
import { evaluateScreening } from '@/features/screening/engine'
import type { QuestionValue, RuleValue } from '@/features/screening/schemas'

/**
 * Deterministic screening engine — docs/13 Phase-5: 100% branch coverage.
 * The safety rail (17 §4.3) is the whole point: nothing ambiguous is ever
 * rejected; everything unclear is review_required.
 */

let seq = 0
function q(partial: Partial<QuestionValue> & { type: QuestionValue['type'] }): QuestionValue {
  seq += 1
  return {
    id: `q${String(seq).padStart(5, '0')}`,
    label: 'Question?',
    required: true,
    classification: 'mandatory',
    ...partial,
  } as QuestionValue
}

describe('aggregation (docs/17 §4.2)', () => {
  it('no questions at all → null (feature off)', () => {
    expect(evaluateScreening([], {}).status).toBeNull()
  })

  it('no mandatory questions → null even with answers', () => {
    const questions = [q({ type: 'text', classification: 'preferred' })]
    expect(evaluateScreening(questions, { [questions[0]!.id]: 'hello' }).status).toBeNull()
  })

  it('mandatory question without rule (schema-forbidden shape) is skipped → null', () => {
    const questions = [q({ type: 'text', rule: undefined })]
    expect(evaluateScreening(questions, {}).status).toBeNull()
  })

  it('any clear fail → does_not_meet_mandatory (details carry the failed rule)', () => {
    const questions = [
      q({ type: 'yes_no', rule: { op: 'eq', value: true } }),
      q({ type: 'number', rule: { op: 'min', value: 2 } }),
    ]
    const answers = { [questions[0]!.id]: true, [questions[1]!.id]: 1 }
    const v = evaluateScreening(questions, answers)
    expect(v.status).toBe('does_not_meet_mandatory')
    expect(v.details.find((d) => d.questionId === questions[1]!.id)?.outcome).toBe('fail')
  })

  it('pass + review → review_required (ambiguity survives, never collapses to reject)', () => {
    const questions = [
      q({ type: 'yes_no', rule: { op: 'eq', value: true } }),
      q({ type: 'number', rule: { op: 'min', value: 2 } }),
    ]
    const answers = { [questions[0]!.id]: true } // second mandatory unanswered
    expect(evaluateScreening(questions, answers).status).toBe('review_required')
  })

  it('fail + review → does_not_meet_mandatory (fail dominates)', () => {
    const questions = [
      q({ type: 'yes_no', rule: { op: 'eq', value: false } }),
      q({ type: 'text', rule: { op: 'contains_any', keywords: ['sql'] } }),
    ]
    const answers = { [questions[0]!.id]: true } // fail on q1, missing q2
    expect(evaluateScreening(questions, answers).status).toBe('does_not_meet_mandatory')
  })

  it('all clear passes → qualified', () => {
    const questions = [
      q({ type: 'yes_no', rule: { op: 'eq', value: true } }),
      q({ type: 'experience_years', rule: { op: 'range', min: 1, max: 10 } }),
    ]
    const answers = { [questions[0]!.id]: true, [questions[1]!.id]: 5 }
    expect(evaluateScreening(questions, answers).status).toBe('qualified')
  })
})

describe('empty-answer handling (missing/blank → review, never reject)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['undefined', {}],
    ['empty string', { ans: '' }],
    ['whitespace string', { ans: '   ' }],
    ['empty array', { ans: [] }],
  ]
  it.each(cases)('%s → review_required', (_label, input) => {
    const question = q({ type: 'text', rule: { op: 'contains_any', keywords: ['x'] } })
    const answers = ('ans' in input ? { [question.id]: input.ans } : {}) as never
    expect(evaluateScreening([question], answers).status).toBe('review_required')
  })
})

describe('eq (yes_no / relocate)', () => {
  const yes = q({ type: 'yes_no', rule: { op: 'eq', value: true } })
  const rel = q({ type: 'relocate', rule: { op: 'eq', value: false } })

  it('boolean equality pass/fail both ways', () => {
    expect(evaluateScreening([yes], { [yes.id]: true }).status).toBe('qualified')
    expect(evaluateScreening([yes], { [yes.id]: false }).status).toBe('does_not_meet_mandatory')
    expect(evaluateScreening([rel], { [rel.id]: true }).status).toBe('does_not_meet_mandatory')
  })

  it('non-boolean answer (string "true" from a tampered payload) → review', () => {
    expect(evaluateScreening([yes], { [yes.id]: 'true' }).status).toBe('review_required')
  })
})

describe('in / not_in (single_choice, dropdown)', () => {
  const opts = ['SQL', 'Python', 'Excel']
  const rule: RuleValue = { op: 'in', values: ['SQL', 'Python'] }
  const single = q({ type: 'single_choice', options: opts, rule })
  const drop = q({ type: 'dropdown', options: opts, rule: { op: 'not_in', values: ['Excel'] } })

  it('membership pass/fail', () => {
    expect(evaluateScreening([single], { [single.id]: 'SQL' }).status).toBe('qualified')
    expect(evaluateScreening([single], { [single.id]: 'Excel' }).status).toBe(
      'does_not_meet_mandatory',
    )
  })

  it('not_in inverts', () => {
    expect(evaluateScreening([drop], { [drop.id]: 'SQL' }).status).toBe('qualified')
    expect(evaluateScreening([drop], { [drop.id]: 'Excel' }).status).toBe('does_not_meet_mandatory')
  })

  it('unknown option value → review (tamper/stale-option safe)', () => {
    expect(evaluateScreening([single], { [single.id]: 'Rust' }).status).toBe('review_required')
    expect(evaluateScreening([drop], { [drop.id]: 'Rust' }).status).toBe('review_required')
  })

  it('non-string answer → review', () => {
    expect(evaluateScreening([single], { [single.id]: 42 }).status).toBe('review_required')
  })
})

describe('includes_* (multiple_choice)', () => {
  const opts = ['SQL', 'PowerBI', 'Excel', 'Python']
  const all = q({
    type: 'multiple_choice',
    options: opts,
    rule: { op: 'includes_all', values: ['SQL', 'PowerBI'] },
  })
  const any = q({
    type: 'multiple_choice',
    options: opts,
    rule: { op: 'includes_any', values: ['Python'] },
  })
  const none = q({
    type: 'multiple_choice',
    options: opts,
    rule: { op: 'includes_none', values: ['Excel'] },
  })

  it('includes_all requires every value', () => {
    expect(evaluateScreening([all], { [all.id]: ['SQL', 'PowerBI', 'Excel'] }).status).toBe(
      'qualified',
    )
    expect(evaluateScreening([all], { [all.id]: ['SQL'] }).status).toBe('does_not_meet_mandatory')
  })

  it('includes_any needs a single hit', () => {
    expect(evaluateScreening([any], { [any.id]: ['Excel', 'Python'] }).status).toBe('qualified')
    expect(evaluateScreening([any], { [any.id]: ['Excel'] }).status).toBe('does_not_meet_mandatory')
  })

  it('includes_none rejects on any hit', () => {
    expect(evaluateScreening([none], { [none.id]: ['SQL'] }).status).toBe('qualified')
    expect(evaluateScreening([none], { [none.id]: ['SQL', 'Excel'] }).status).toBe(
      'does_not_meet_mandatory',
    )
  })

  it('array containing unknown option → review; non-array → review', () => {
    expect(evaluateScreening([all], { [all.id]: ['SQL', 'Rust'] }).status).toBe('review_required')
    expect(evaluateScreening([all], { [all.id]: 'SQL' }).status).toBe('review_required')
    expect(evaluateScreening([all], { [all.id]: [1, 2] } as never).status).toBe('review_required')
  })
})

describe('min / max / range (number, experience_years, CTC)', () => {
  const minQ = q({ type: 'experience_years', rule: { op: 'min', value: 2 } })
  const maxQ = q({ type: 'expected_ctc', rule: { op: 'max', value: 1_500_000 } })
  const rangeQ = q({ type: 'current_ctc', rule: { op: 'range', min: 500_000, max: 2_000_000 } })

  it('bounds inclusive', () => {
    expect(evaluateScreening([minQ], { [minQ.id]: 2 }).status).toBe('qualified')
    expect(evaluateScreening([minQ], { [minQ.id]: 1.9 }).status).toBe('does_not_meet_mandatory')
    expect(evaluateScreening([maxQ], { [maxQ.id]: 1_500_000 }).status).toBe('qualified')
    expect(evaluateScreening([maxQ], { [maxQ.id]: 1_500_001 }).status).toBe(
      'does_not_meet_mandatory',
    )
  })

  it('range both bounds', () => {
    expect(evaluateScreening([rangeQ], { [rangeQ.id]: 1_000_000 }).status).toBe('qualified')
    expect(evaluateScreening([rangeQ], { [rangeQ.id]: 499_999 }).status).toBe(
      'does_not_meet_mandatory',
    )
    expect(evaluateScreening([rangeQ], { [rangeQ.id]: 2_000_001 }).status).toBe(
      'does_not_meet_mandatory',
    )
  })

  it('open range (min only / max only) works', () => {
    const openMin = q({ type: 'number', rule: { op: 'range', min: 5 } })
    const openMax = q({ type: 'number', rule: { op: 'range', max: 5 } })
    expect(evaluateScreening([openMin], { [openMin.id]: 99 }).status).toBe('qualified')
    expect(evaluateScreening([openMax], { [openMax.id]: 4 }).status).toBe('qualified')
  })

  it('non-finite / non-number → review', () => {
    expect(evaluateScreening([minQ], { [minQ.id]: 'two' }).status).toBe('review_required')
    expect(evaluateScreening([minQ], { [minQ.id]: Number.NaN }).status).toBe('review_required')
  })
})

describe('contains_any / not_empty (text, location)', () => {
  const kw = q({ type: 'location', rule: { op: 'contains_any', keywords: ['Lucknow', 'Remote'] } })
  const ne = q({ type: 'text', rule: { op: 'not_empty' } })

  it('case-insensitive keyword hit', () => {
    expect(evaluateScreening([kw], { [kw.id]: 'Based in LUCKNOW, UP' }).status).toBe('qualified')
    expect(evaluateScreening([kw], { [kw.id]: 'Jaipur' }).status).toBe('does_not_meet_mandatory')
  })

  it('not_empty accepts anything non-blank, blank → review', () => {
    expect(evaluateScreening([ne], { [ne.id]: 'whatever' }).status).toBe('qualified')
    expect(evaluateScreening([ne], { [ne.id]: '' }).status).toBe('review_required')
    expect(evaluateScreening([ne], { [ne.id]: 7 }).status).toBe('review_required')
  })
})

describe('min_level (education ladder)', () => {
  const edu = q({ type: 'education', rule: { op: 'min_level', level: 'bachelors' } })

  it('at or above threshold passes; below fails', () => {
    expect(evaluateScreening([edu], { [edu.id]: 'bachelors' }).status).toBe('qualified')
    expect(evaluateScreening([edu], { [edu.id]: 'masters' }).status).toBe('qualified')
    expect(evaluateScreening([edu], { [edu.id]: 'doctorate' }).status).toBe('qualified')
    expect(evaluateScreening([edu], { [edu.id]: 'diploma' }).status).toBe('does_not_meet_mandatory')
    expect(evaluateScreening([edu], { [edu.id]: 'high_school' }).status).toBe(
      'does_not_meet_mandatory',
    )
  })

  it('unknown level / non-string → review', () => {
    expect(evaluateScreening([edu], { [edu.id]: 'phd-ish' }).status).toBe('review_required')
    expect(evaluateScreening([edu], { [edu.id]: true }).status).toBe('review_required')
  })
})

describe('multi-rule question sets (order independence)', () => {
  it('a failing rule later in the list still fails the verdict', () => {
    const questions = [
      q({ type: 'yes_no', rule: { op: 'eq', value: true } }),
      q({ type: 'yes_no', rule: { op: 'eq', value: true } }),
    ]
    const answers = { [questions[0]!.id]: true, [questions[1]!.id]: false }
    expect(evaluateScreening(questions, answers).status).toBe('does_not_meet_mandatory')
  })

  it('details length equals mandatory-rule count', () => {
    const questions = [
      q({ type: 'yes_no', rule: { op: 'eq', value: true } }),
      q({ type: 'text', classification: 'preferred' }), // excluded
      q({ type: 'number', rule: { op: 'min', value: 0 } }),
    ]
    const answers = { [questions[0]!.id]: true, [questions[2]!.id]: 5 }
    const v = evaluateScreening(questions, answers)
    expect(v.status).toBe('qualified')
    expect(v.details).toHaveLength(2)
  })
})
