import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  Question,
  ScreeningConfig,
  SaveScreeningConfigInput,
  PublicQuestion,
  sanitizeQuestions,
  validateAnswers,
  parseScreeningConfig,
  MAX_QUESTIONS,
  type QuestionValue,
} from '@/features/screening/schemas'

/**
 * Screening questionnaire schemas + sanitization + answers validation —
 * docs/13 Phase-5 (always-on). Complements tests/screening-engine.test.ts
 * (which owns the pure evaluation logic). Later 5.x stages grow this file
 * with ScreeningResultSchema / prompt / session guards.
 */

const YES_NO = {
  id: 'qyn001',
  label: 'Are you authorized to work here?',
  type: 'yes_no',
  classification: 'mandatory',
  rule: { op: 'eq', value: true },
}

const CHOICE = {
  id: 'qsc001',
  label: 'Which shift can you work?',
  type: 'single_choice',
  options: ['Day', 'Night', 'Rotating'],
  classification: 'mandatory',
  rule: { op: 'in', values: ['Night', 'Rotating'] },
}

function question(partial: Record<string, unknown> = {}) {
  return { ...YES_NO, ...partial }
}

describe('Question schema — shape constraints (17 §3.1)', () => {
  it('parses a valid mandatory question', () => {
    const q = Question.parse(YES_NO)
    expect(q.id).toBe('qyn001')
    expect(q.required).toBe(true)
    expect(q.rule).toEqual({ op: 'eq', value: true })
  })

  it('defaults required=true and classification=informational', () => {
    const q = Question.parse({ id: 'qyn002', label: 'Anything we should know?', type: 'text' })
    expect(q.required).toBe(true)
    expect(q.classification).toBe('informational')
  })

  it('id must be exactly nanoid-6 lowercase', () => {
    expect(Question.safeParse(question({ id: 'ABC123' })).success).toBe(false)
    expect(Question.safeParse(question({ id: 'abcde' })).success).toBe(false)
    expect(Question.safeParse(question({ id: 'abcdefg' })).success).toBe(false)
    expect(Question.safeParse(question({ id: 'ab_123' })).success).toBe(false)
    expect(Question.safeParse(question({ id: 'zz9000' })).success).toBe(true)
  })

  it('label is trimmed and bounded 3–140', () => {
    expect(Question.safeParse(question({ label: 'ab' })).success).toBe(false)
    expect(Question.safeParse(question({ label: 'x'.repeat(141) })).success).toBe(false)
    const q = Question.parse(question({ label: '  Reasonable length?  ' }))
    expect(q.label).toBe('Reasonable length?')
  })

  it('is strict — unknown fields are rejected', () => {
    expect(Question.safeParse(question({ internal_note: 'shh' })).success).toBe(false)
  })
})

describe('Question schema — options rules (17 §3.1)', () => {
  it('choice questions need 2–12 options', () => {
    const withOpts = (options: string[]) => ({
      ...CHOICE,
      options,
      rule: { op: 'in', values: [options[0]!] },
    })
    expect(Question.safeParse(withOpts(['Only'])).success).toBe(false)
    expect(
      Question.safeParse(withOpts(Array.from({ length: 13 }, (_, i) => `o${i}`))).success,
    ).toBe(false)
    expect(Question.safeParse(withOpts(['A', 'B'])).success).toBe(true)
    expect(
      Question.safeParse(withOpts(Array.from({ length: 12 }, (_, i) => `o${i}`))).success,
    ).toBe(true)
  })

  it('multiple_choice and dropdown follow the same options contract', () => {
    expect(
      Question.safeParse({
        ...CHOICE,
        type: 'multiple_choice',
        rule: { op: 'includes_all', values: ['Day'] },
        options: ['Day'],
      }).success,
    ).toBe(false)
    expect(Question.safeParse({ ...CHOICE, type: 'dropdown' }).success).toBe(true)
  })

  it('options must be unique (case-insensitive)', () => {
    const withRule = (options: string[]) => ({
      ...CHOICE,
      options,
      rule: { op: 'in', values: ['sql'] },
    })
    expect(Question.safeParse(withRule(['SQL', 'sql'])).success).toBe(false)
    expect(
      Question.safeParse({
        ...CHOICE,
        options: ['SQL', 'Excel'],
        rule: { op: 'in', values: ['SQL'] },
      }).success,
    ).toBe(true)
  })

  it('non-choice questions must not carry options', () => {
    expect(Question.safeParse(question({ options: ['a', 'b'] })).success).toBe(false)
    // an empty array is tolerated (builder round-trips), non-empty is not
    expect(Question.safeParse(question({ options: [] })).success).toBe(true)
  })

  it('options items are trimmed, 1–60 chars', () => {
    expect(Question.safeParse({ ...CHOICE, options: ['', 'B'] }).success).toBe(false)
    expect(Question.safeParse({ ...CHOICE, options: ['x'.repeat(61), 'B'] }).success).toBe(false)
  })
})

describe('Question schema — classification ⇔ rule coupling (17 §3.2)', () => {
  it('mandatory requires a rule', () => {
    const { rule: _rule, ...noRule } = YES_NO
    expect(Question.safeParse(noRule).success).toBe(false)
  })

  it('preferred/informational must not carry a rule', () => {
    expect(Question.safeParse(question({ classification: 'preferred' })).success).toBe(false)
    expect(Question.safeParse(question({ classification: 'informational' })).success).toBe(false)
  })

  it('preferred/informational without a rule parse fine', () => {
    expect(
      Question.safeParse({ ...YES_NO, classification: 'preferred', rule: undefined }).success,
    ).toBe(true)
  })
})

describe('Question schema — operator/type coherence (17 §4.1)', () => {
  it.each([
    ['yes_no', { op: 'min', value: 1 }],
    ['number', { op: 'eq', value: true }],
    ['experience_years', { op: 'contains_any', keywords: ['x'] }],
    ['text', { op: 'min_level', level: 'bachelors' }],
    ['dropdown', { op: 'includes_all', values: ['Day'] }],
    ['single_choice', { op: 'range', min: 1 }],
    ['education', { op: 'eq', value: true }],
    ['expected_ctc', { op: 'in', values: ['x'] }],
  ])('%s + %o → rejected', (type, rule) => {
    const base =
      type === 'single_choice' || type === 'dropdown'
        ? { ...CHOICE, type, options: ['Day', 'Night'] }
        : question({ type })
    expect(Question.safeParse({ ...base, rule }).success).toBe(false)
  })

  it.each([
    ['multiple_choice', { op: 'includes_any', values: ['Day'] }, { options: ['Day', 'Night'] }],
    ['text', { op: 'not_empty' }, {}],
    ['location', { op: 'contains_any', keywords: ['lucknow'] }, {}],
    ['education', { op: 'min_level', level: 'bachelors' }, {}],
    ['relocate', { op: 'eq', value: true }, {}],
  ])('%s + %o → accepted', (type, rule, extra) => {
    const base =
      type === 'multiple_choice' ? { ...CHOICE, type, ...extra } : question({ type, ...extra })
    expect(Question.safeParse({ ...base, rule }).success).toBe(true)
  })

  it('eq value must be a boolean', () => {
    expect(Question.safeParse(question({ rule: { op: 'eq', value: 'true' } })).success).toBe(false)
  })

  it('min/max values must be finite numbers', () => {
    const numQ = question({ type: 'number' })
    expect(Question.safeParse({ ...numQ, rule: { op: 'min', value: 'big' } }).success).toBe(false)
    expect(Question.safeParse({ ...numQ, rule: { op: 'min', value: Infinity } }).success).toBe(
      false,
    )
    expect(Question.safeParse({ ...numQ, rule: { op: 'min', value: 2 } }).success).toBe(true)
  })

  it('range needs at least one bound', () => {
    const numQ = question({ type: 'number' })
    expect(Question.safeParse({ ...numQ, rule: { op: 'range' } }).success).toBe(false)
    expect(Question.safeParse({ ...numQ, rule: { op: 'range', min: 1 } }).success).toBe(true)
    expect(Question.safeParse({ ...numQ, rule: { op: 'range', max: 9 } }).success).toBe(true)
    expect(Question.safeParse({ ...numQ, rule: { op: 'range', min: 1, max: 9 } }).success).toBe(
      true,
    )
  })

  it('in/not_in/include values are 1–12 entries', () => {
    expect(Question.safeParse({ ...CHOICE, rule: { op: 'in', values: [] } }).success).toBe(false)
    expect(
      Question.safeParse({
        ...CHOICE,
        options: Array.from({ length: 12 }, (_, i) => `o${i}`),
        rule: { op: 'not_in', values: Array.from({ length: 13 }, (_, i) => `v${i}`) },
      }).success,
    ).toBe(false)
  })

  it('contains_any keywords are 1–12 non-blank entries', () => {
    const textQ = question({ type: 'text' })
    expect(
      Question.safeParse({ ...textQ, rule: { op: 'contains_any', keywords: ['  '] } }).success,
    ).toBe(false)
    expect(
      Question.safeParse({
        ...textQ,
        rule: { op: 'contains_any', keywords: Array.from({ length: 13 }, (_, i) => `k${i}`) },
      }).success,
    ).toBe(false)
    expect(
      Question.safeParse({ ...textQ, rule: { op: 'contains_any', keywords: ['leadership'] } })
        .success,
    ).toBe(true)
  })

  it('optioned rule values must be chosen from the options', () => {
    expect(
      Question.safeParse({ ...CHOICE, rule: { op: 'in', values: ['Day', 'Evening'] } }).success,
    ).toBe(false)
    expect(Question.safeParse({ ...CHOICE, rule: { op: 'not_in', values: ['Day'] } }).success).toBe(
      true,
    )
  })
})

describe('ScreeningConfig', () => {
  it('defaults to an empty questionnaire', () => {
    expect(ScreeningConfig.parse({})).toEqual({ questions: [] })
  })

  it(`caps at ${MAX_QUESTIONS} questions`, () => {
    const many = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
      id: `q${String(i).padStart(5, '0')}`,
      label: 'Free text answer?',
      type: 'text',
    }))
    expect(ScreeningConfig.safeParse({ questions: many }).success).toBe(false)
    expect(ScreeningConfig.safeParse({ questions: many.slice(0, MAX_QUESTIONS) }).success).toBe(
      true,
    )
  })

  it('rejects duplicate question ids', () => {
    expect(ScreeningConfig.safeParse({ questions: [YES_NO, YES_NO] }).success).toBe(false)
    expect(ScreeningConfig.safeParse({ questions: [YES_NO, CHOICE] }).success).toBe(true)
  })

  it('is strict at the top level', () => {
    expect(ScreeningConfig.safeParse({ questions: [], extra: 1 }).success).toBe(false)
  })
})

describe('SaveScreeningConfigInput (builder PUT)', () => {
  it('accepts questions without ids (server assigns them)', () => {
    const { id: _id, ...withoutId } = YES_NO
    const parsed = SaveScreeningConfigInput.parse({ questions: [withoutId] })
    expect(parsed.questions).toHaveLength(1)
  })

  it('keeps provided ids and still enforces cross-field rules', () => {
    expect(SaveScreeningConfigInput.safeParse({ questions: [YES_NO] }).success).toBe(true)
    const { rule: _rule, ...noRule } = YES_NO
    expect(SaveScreeningConfigInput.safeParse({ questions: [noRule] }).success).toBe(false)
    expect(
      SaveScreeningConfigInput.safeParse({
        questions: [{ ...YES_NO, rule: { op: 'min', value: 1 } }],
      }).success,
    ).toBe(false)
  })

  it('caps question count', () => {
    const many = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({
      id: `q${String(i).padStart(5, '0')}`,
      label: 'Free text answer?',
      type: 'text',
    }))
    expect(SaveScreeningConfigInput.safeParse({ questions: many }).success).toBe(false)
  })
})

describe('sanitizeQuestions — Q7 leak check (17 §3.4)', () => {
  const config = ScreeningConfig.parse({
    questions: [
      YES_NO,
      CHOICE,
      { id: 'qtx001', label: 'Tell us about yourself', type: 'text', required: false },
    ],
  })
  const pub = sanitizeQuestions(config.questions)

  it('never projects classification or rule — at any depth', () => {
    const raw = JSON.stringify(pub)
    expect(raw).not.toContain('classification')
    expect(raw).not.toContain('rule')
    expect(raw).not.toContain('does_not_meet')
    for (const q of pub) {
      expect(q).not.toHaveProperty('classification')
      expect(q).not.toHaveProperty('rule')
    }
  })

  it('keeps the public fields; options only on choice questions', () => {
    expect(pub[0]).toEqual({
      id: 'qyn001',
      label: YES_NO.label,
      required: true,
      type: 'yes_no',
    })
    expect(pub[1]).toMatchObject({ options: ['Day', 'Night', 'Rotating'] })
    expect(pub[2]).not.toHaveProperty('options')
  })

  it('output passes the PublicQuestion contract', () => {
    for (const q of pub) expect(PublicQuestion.parse(q)).toBeTruthy()
  })
})

describe('validateAnswers — apply payload validation (17 §5)', () => {
  const questions: QuestionValue[] = [
    Question.parse(YES_NO), // required
    Question.parse({ ...CHOICE, required: false }), // optional
    Question.parse({
      id: 'qmc001',
      label: 'Which tools have you used?',
      type: 'multiple_choice',
      options: ['SQL', 'Excel', 'CRM'],
      classification: 'mandatory',
      rule: { op: 'includes_all', values: ['SQL'] },
    }),
    Question.parse({
      id: 'qex001',
      label: 'Years of experience?',
      type: 'experience_years',
      classification: 'mandatory',
      rule: { op: 'min', value: 2 },
    }),
    Question.parse({
      id: 'qed001',
      label: 'Highest education?',
      type: 'education',
      required: false,
    }),
    Question.parse({ id: 'qtx002', label: 'Why this role?', type: 'text' }),
  ]

  const happy = {
    qyn001: true,
    qmc001: ['SQL'],
    qex001: 3,
    qtx002: 'Because.',
  }

  it('happy path → ok with cleaned, typed answers', () => {
    const r = validateAnswers(questions, happy)
    expect(r.ok).toBe(true)
    expect(r.fieldErrors).toEqual({})
    expect(r.cleaned).toEqual({ qyn001: true, qmc001: ['SQL'], qex001: 3, qtx002: 'Because.' })
  })

  it('drops unknown question ids silently', () => {
    const r = validateAnswers(questions, { ...happy, rogue99: 'x', qyn001: true })
    expect(r.ok).toBe(true)
    expect(r.cleaned).not.toHaveProperty('rogue99')
  })

  it('missing required answers → field errors keyed answers.<id>', () => {
    const r = validateAnswers(questions, { qmc001: ['SQL'] })
    expect(r.ok).toBe(false)
    expect(Object.keys(r.fieldErrors)).toEqual(
      expect.arrayContaining(['answers.qyn001', 'answers.qex001', 'answers.qtx002']),
    )
    expect(r.fieldErrors['answers.qyn001']).toEqual(['This question needs an answer.'])
  })

  it('missing optional answers are skipped entirely', () => {
    const r = validateAnswers(questions, happy)
    expect(r.cleaned).not.toHaveProperty('qsc001')
    expect(r.cleaned).not.toHaveProperty('qed001')
    expect(r.ok).toBe(true)
  })

  it('yes_no coerces true/false strings; anything else errors', () => {
    const only = [questions[0]!]
    expect(validateAnswers(only, { qyn001: 'true' }).cleaned.qyn001).toBe(true)
    expect(validateAnswers(only, { qyn001: 'false' }).cleaned.qyn001).toBe(false)
    expect(validateAnswers(only, { qyn001: 'maybe' }).ok).toBe(false)
  })

  it('single_choice must be one of the options', () => {
    const r = validateAnswers(questions, { ...happy, qsc001: 'Evening' })
    expect(r.ok).toBe(false)
    expect(r.fieldErrors).toHaveProperty('answers.qsc001')
    expect(validateAnswers(questions, { ...happy, qsc001: 'Day' }).ok).toBe(true)
  })

  it('multiple_choice: dedupes, rejects non-arrays, empty arrays, unknown options', () => {
    expect(
      validateAnswers(questions, { ...happy, qmc001: ['SQL', 'SQL', 'CRM'] }).cleaned.qmc001,
    ).toEqual(['SQL', 'CRM'])
    for (const bad of ['SQL', [], ['Rust'], [1]]) {
      expect(validateAnswers(questions, { ...happy, qmc001: bad }).ok).toBe(false)
    }
  })

  it('numeric types strip ₹ $ , and spaces; reject negatives, garbage, absurd magnitudes', () => {
    const money = [
      Question.parse({
        id: 'qct001',
        label: 'Expected CTC?',
        type: 'expected_ctc',
        classification: 'mandatory',
        rule: { op: 'max', value: 2_000_000 },
      }),
    ]
    expect(validateAnswers(money, { qct001: '₹ 12,00,000' }).cleaned.qct001).toBe(1_200_000)
    expect(validateAnswers(money, { qct001: '$1,200.50' }).cleaned.qct001).toBe(1200.5)
    expect(validateAnswers(money, { qct001: 900_000 }).cleaned.qct001).toBe(900_000)
    for (const bad of ['abc', -1, 2_000_000_000_000]) {
      expect(validateAnswers(money, { qct001: bad }).ok).toBe(false)
    }
    expect(validateAnswers(questions, { ...happy, qex001: '3.5' }).cleaned.qex001).toBe(3.5)
  })

  it('education must be a ladder level', () => {
    expect(validateAnswers(questions, { ...happy, qed001: 'masters' }).cleaned.qed001).toBe(
      'masters',
    )
    expect(validateAnswers(questions, { ...happy, qed001: 'phd' }).ok).toBe(false)
  })

  it('text is trimmed and capped at 500 chars', () => {
    expect(validateAnswers(questions, { ...happy, qtx002: '  hello  ' }).cleaned.qtx002).toBe(
      'hello',
    )
    expect(validateAnswers(questions, { ...happy, qtx002: 'x'.repeat(501) }).ok).toBe(false)
    expect(validateAnswers(questions, { ...happy, qtx002: '   ' }).ok).toBe(false)
  })
})

describe('parseScreeningConfig — lenient DB reads (never trust jsonb)', () => {
  it.each([['string'], [null], [undefined], [{ questions: 'nope' }], [42]])(
    '%o → empty questionnaire',
    (raw) => {
      expect(parseScreeningConfig(raw)).toEqual({ questions: [] })
    },
  )

  it('a config with one invalid question falls back to empty (not half-parsed)', () => {
    expect(parseScreeningConfig({ questions: [YES_NO, { id: 'bad' }] })).toEqual({ questions: [] })
  })

  it('valid config round-trips', () => {
    const parsed = parseScreeningConfig({ questions: [YES_NO] })
    expect(parsed.questions).toHaveLength(1)
  })
})

describe('migration 0007 SQL sanity (docs/13 §Phase-5 — static checks)', () => {
  const sql = readFileSync('supabase/migrations/0007_phase5_screening.sql', 'utf8')
  const NEW_TABLES = [
    'application_answers',
    'applicant_profiles',
    'ai_screening_sessions',
    'ai_screening_results',
  ]

  it('creates the four Phase-5 tables', () => {
    for (const table of NEW_TABLES) {
      expect(sql).toMatch(new RegExp(`create table if not exists public\\.${table}`, 'i'))
    }
  })

  it('RLS enabled on every new table (docs/07 §1)', () => {
    for (const table of NEW_TABLES) {
      expect(sql).toMatch(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`, 'i'),
      )
    }
  })

  it('owner + org policies on every new table (17 §10)', () => {
    for (const policy of [
      'answers_owner_read',
      'answers_org_read',
      'applicant_profiles_owner',
      'applicant_profiles_org',
      'screening_sessions_owner',
      'screening_sessions_org',
      'screening_results_owner',
      'screening_results_org',
    ]) {
      expect(sql).toMatch(new RegExp(`create policy ${policy}`, 'i'))
    }
  })

  it('questionnaire config + verdict column + timeline enum extension', () => {
    expect(sql).toMatch(
      /alter table public\.jobs\s+add column if not exists screening_config jsonb/i,
    )
    expect(sql).toMatch(
      /alter table public\.applications\s+add column if not exists screening_status/i,
    )
    expect(sql).toMatch(
      /check \(screening_status in \('qualified','does_not_meet_mandatory','review_required'\)\)/i,
    )
    expect(sql).toMatch(
      /alter type public\.timeline_event_type add value if not exists 'questionnaire_screened'/i,
    )
  })

  it('creates the Phase-5 indexes', () => {
    for (const idx of [
      'answers_application_idx',
      'screening_sessions_job_idx',
      'screening_results_session_idx',
      'applications_job_screening_idx',
    ]) {
      expect(sql).toMatch(new RegExp(`create index if not exists ${idx}`, 'i'))
    }
  })

  it('is additive-only and re-runnable (no drops, guarded DDL)', () => {
    expect(sql).not.toMatch(/drop table/i)
    expect(sql).not.toMatch(/alter table public\.(jobs|applications)\s+drop/i)
    expect(sql).toMatch(/add column if not exists/i)
  })

  it('answers stay service-written (user RLS is read-only — 17 §5)', () => {
    const verbs = [
      ...sql.matchAll(/create policy \w+ on public\.application_answers\s+for (\w+)/gi),
    ].map((m) => m[1]!.toLowerCase())
    expect(verbs).toEqual(['select', 'select'])
  })
})
