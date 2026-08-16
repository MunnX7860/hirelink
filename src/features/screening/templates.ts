import type { QuestionValue } from '@/features/screening/schemas'

/**
 * Ready-made questionnaires (docs/17 §3) — so a recruiter never faces a blank
 * builder. Deliberately role-agnostic: guessing at industry-specific questions
 * would be worse than useless, and the recruiter can edit or delete any row.
 *
 * Ids are `tmp-*` on purpose. The builder treats that prefix as "new question,
 * server assigns the real nanoid-6 id on save" — a template is just a pre-filled
 * draft, never a saved entity, so nothing here needs its own persistence.
 *
 * Only `experience_years` ships as a must-have. Everything else is
 * informational: a template that silently rejects candidates the moment it's
 * applied would be a nasty surprise, so the destructive setting is opt-in.
 */

let seq = 0
/** Fresh draft id per call — templates may be applied more than once per session. */
function draftId(): string {
  seq += 1
  return `tmp-t${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export interface QuestionnaireTemplate {
  id: string
  name: string
  /** One line shown under the name in the picker. */
  summary: string
  build: () => QuestionValue[]
}

export const QUESTIONNAIRE_TEMPLATES: QuestionnaireTemplate[] = [
  {
    id: 'starter',
    name: 'Standard screening questions',
    summary:
      'Experience, notice period, expected salary, location and education. Works for most roles.',
    build: () => [
      {
        id: draftId(),
        label: 'How many years of relevant work experience do you have?',
        required: true,
        type: 'experience_years',
        classification: 'mandatory',
        rule: { op: 'min', value: 1 },
      },
      {
        id: draftId(),
        label: 'How soon can you join? (notice period in days)',
        required: true,
        type: 'number',
        classification: 'informational',
      },
      {
        id: draftId(),
        label: 'What salary are you expecting per year?',
        required: true,
        type: 'expected_ctc',
        classification: 'informational',
      },
      {
        id: draftId(),
        label: 'Which city are you currently based in?',
        required: true,
        type: 'location',
        classification: 'informational',
      },
      {
        id: draftId(),
        label: 'What is your highest completed education?',
        required: true,
        type: 'education',
        classification: 'informational',
      },
    ],
  },
]

/**
 * Re-keys a questionnaire copied from another job into fresh drafts.
 * Real nanoid-6 ids must NOT be reused across jobs — `application_answers`
 * rows reference question ids, so two jobs sharing an id would make an answer
 * ambiguous about which job's question it belongs to. Rules and wording carry
 * over; identity does not.
 */
export function asDraftQuestions(questions: QuestionValue[]): QuestionValue[] {
  return questions.map((q) => ({ ...q, id: draftId() }))
}
