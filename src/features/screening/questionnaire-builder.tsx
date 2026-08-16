'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Badge } from '@/ui/badge'
import { useToast } from '@/ui/toaster'
import { cn } from '@/lib/utils'
import { ApiError, mutate } from '@/lib/api-client'
import {
  QUESTIONNAIRE_TEMPLATES,
  asDraftQuestions,
  type QuestionnaireTemplate,
} from '@/features/screening/templates'
import type { ReusableQuestionnaire } from '@/features/screening/server'
import {
  EDUCATION_LEVELS,
  EDUCATION_LABELS,
  QUESTION_TYPES,
  sanitizeQuestions,
  type PublicQuestionValue,
  type QuestionClassValue,
  type QuestionTypeValue,
  type QuestionValue,
  type RuleValue,
} from '@/features/screening/schemas'

/**
 * Questionnaire builder — docs/17 §3, docs/06 pattern: one section on the job
 * edit page. Rules stay PRIVATE (17 §3.4). Whole-config PUT (ids server-assigned
 * for new questions), separate "Re-run screening" for existing applications
 * (17 §4.4). All validation is mirrored client-side; server remains authoritative.
 */

const TYPE_LABELS: Record<QuestionTypeValue, string> = {
  yes_no: 'Yes / No',
  single_choice: 'Single choice (radio)',
  multiple_choice: 'Multiple choice (checkboxes)',
  dropdown: 'Dropdown',
  text: 'Short text',
  number: 'Number',
  education: 'Education level',
  experience_years: 'Years of experience',
  location: 'Location',
  current_ctc: 'Current CTC (per year)',
  expected_ctc: 'Expected CTC (per year)',
  relocate: 'Willing to relocate (Yes/No)',
}

// Turns the generic "Some fields are invalid." into something actionable by
// pulling the first couple of per-field Zod messages out of ApiError.details
// (keyed like "questions.0.rule" — question index is 0-based server-side).
function describeError(err: ApiError): string {
  const entries = Object.entries(err.details ?? {})
  if (entries.length === 0) return err.message
  const specifics = entries.slice(0, 2).map(([path, messages]) => {
    const match = /^questions\.(\d+)\./.exec(path)
    const prefix = match ? `Question ${Number(match[1]) + 1}: ` : ''
    return `${prefix}${Array.isArray(messages) ? messages[0] : String(messages)}`
  })
  return `${err.message} ${specifics.join(' ')}`
}

/**
 * The three classifications in recruiter language. Same underlying values as
 * docs/17 §3 — only the wording changes. Rendered as one row of buttons rather
 * than a dropdown so the current choice and its consequence are both visible
 * without a click.
 */
const IMPORTANCE: Array<{ value: QuestionClassValue; label: string; hint: string }> = [
  {
    value: 'mandatory',
    label: 'Must have',
    hint: 'Decides the result. A wrong answer marks the candidate Not qualified.',
  },
  {
    value: 'preferred',
    label: 'Nice to have',
    hint: "Doesn't decide anything on its own. AI screening weighs it when ranking.",
  },
  {
    value: 'informational',
    label: 'Just asking',
    hint: 'Collected for your reference only. Never affects the result.',
  },
]

/** Types a recruiter reaches for most often; the rest live behind "More types". */
const COMMON_TYPES: QuestionTypeValue[] = ['yes_no', 'experience_years', 'single_choice', 'text']

const CHOICE_TYPES = new Set<QuestionTypeValue>(['single_choice', 'multiple_choice', 'dropdown'])
const NUMERIC_TYPES = new Set<QuestionTypeValue>([
  'number',
  'experience_years',
  'current_ctc',
  'expected_ctc',
])

interface NumericDraft {
  min: string
  max: string
}

// The RuleEditor shows a sensible default (e.g. "Qualifies when answered: Yes")
// for yes_no/education/text before the user has touched the control — this seeds
// that same default into state the moment a question becomes mandatory, so a
// user who agrees with the default and never opens the control doesn't silently
// save with no rule at all (server rejects mandatory questions with no rule).
function defaultRuleFor(type: QuestionTypeValue): RuleValue | undefined {
  if (type === 'yes_no' || type === 'relocate') return { op: 'eq', value: true }
  if (type === 'education') return { op: 'min_level', level: 'bachelors' }
  if (type === 'text' || type === 'location') return { op: 'not_empty' }
  return undefined
}

function defaultQuestion(type: QuestionTypeValue): QuestionValue {
  const base = {
    id: `tmp-${Math.random().toString(36).slice(2, 8)}`,
    label: '',
    required: true,
    type,
    classification: 'informational' as const,
  }
  if (CHOICE_TYPES.has(type)) return { ...base, options: ['', ''] }
  if (type === 'text' || type === 'location') return base as QuestionValue
  return base as QuestionValue
}

const CHOICE_RULE_OPS: Array<{ op: RuleValue['op']; label: string }> = [
  { op: 'in', label: 'Is one of' },
  { op: 'not_in', label: 'Is NOT one of' },
]
const MULTI_RULE_OPS: Array<{ op: RuleValue['op']; label: string }> = [
  { op: 'includes_all', label: 'Includes ALL of' },
  { op: 'includes_any', label: 'Includes at least ONE of' },
  { op: 'includes_none', label: 'Includes NONE of' },
]
const TEXT_RULE_OPS: Array<{ op: RuleValue['op']; label: string }> = [
  { op: 'contains_any', label: 'Mentions any of (keywords)' },
  { op: 'not_empty', label: 'Answered at all' },
]

export function QuestionnaireBuilder({
  jobId,
  initialQuestions,
  reusable = [],
  showRecompute = true,
}: {
  jobId: string
  initialQuestions: QuestionValue[]
  /** Other jobs whose questionnaires can be copied (docs/17 §3). */
  reusable?: ReusableQuestionnaire[]
  /**
   * Off inside the create wizard: a job that was made seconds ago has no
   * existing applications to recompute, so the control is pure noise there.
   */
  showRecompute?: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [questions, setQuestions] = useState<QuestionValue[]>(initialQuestions)
  const [saving, setSaving] = useState(false)
  const [recomputing, setRecomputing] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)

  const hasMandatory = questions.some((q) => q.classification === 'mandatory')
  const dirty = JSON.stringify(questions) !== JSON.stringify(initialQuestions)
  const atLimit = questions.length >= 20

  function addQuestion(type: QuestionTypeValue) {
    setQuestions((prev) => (prev.length >= 20 ? prev : [...prev, defaultQuestion(type)]))
  }

  function update(index: number, patch: Partial<QuestionValue>) {
    setQuestions((prev) =>
      prev.map((q, i) => (i === index ? ({ ...q, ...patch } as QuestionValue) : q)),
    )
  }

  function move(index: number, dir: -1 | 1) {
    setQuestions((prev) => {
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(index + dir, 0, item!)
      return next
    })
  }

  function optionsText(q: QuestionValue): string {
    return (q.options ?? []).join('\n')
  }

  function setOptionsFromText(index: number, text: string) {
    update(index, { options: text.split('\n') })
  }

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      // tmp-* ids are new questions → server assigns real nanoid-6 ids.
      const payload = {
        questions: questions.map(({ id, ...rest }) => ({
          ...(id.startsWith('tmp-') ? {} : { id }),
          ...rest,
          options: (rest.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0),
        })),
      }
      await mutate(`/api/jobs/${jobId}/screening-config`, 'PUT', payload)
      toast('Questionnaire saved ✓', { tone: 'success' })
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? describeError(err) : 'Could not save the questionnaire.', {
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  async function recompute() {
    if (recomputing) return
    setRecomputing(true)
    try {
      const result = await mutate<{ recomputed: number; changed: number }>(
        `/api/jobs/${jobId}/screening-recompute`,
        'POST',
      )
      toast(
        `Screening re-ran for ${result.recomputed} applications — ${result.changed} verdicts changed.`,
        { tone: 'success' },
      )
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not re-run screening.', {
        tone: 'danger',
      })
    } finally {
      setRecomputing(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Screening questionnaire</CardTitle>
        {hasMandatory ? (
          <Badge tone="success">screening on</Badge>
        ) : (
          <Badge tone="muted">off</Badge>
        )}
      </CardHeader>

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-secondary">
          Candidates answer these when they apply. Answers you mark <strong>Must have</strong>{' '}
          decide whether they show up as Qualified — candidates never see which ones matter.
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPreviewMode((v) => !v)}
          aria-pressed={previewMode}
        >
          {previewMode ? '← Back to editor' : 'See what candidates see'}
        </Button>
      </div>

      {previewMode ? (
        <CandidatePreview questions={questions} />
      ) : questions.length === 0 ? (
        <StartFrom reusable={reusable} disabled={saving} onPick={(qs) => setQuestions(qs)} />
      ) : (
        <ol className="mb-4 flex flex-col gap-3">
          {questions.map((q, index) => (
            <li key={q.id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <Badge tone="muted">{TYPE_LABELS[q.type]}</Badge>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => move(index, -1)}
                    disabled={index === 0 || saving}
                    aria-label="Move question up"
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => move(index, 1)}
                    disabled={index === questions.length - 1 || saving}
                    aria-label="Move question down"
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    onClick={() => setQuestions((prev) => prev.filter((_, i) => i !== index))}
                    disabled={saving}
                  >
                    Remove
                  </Button>
                </div>
              </div>

              <div className="mt-2 flex flex-col gap-2">
                <Input
                  label="Question"
                  value={q.label}
                  onChange={(e) => update(index, { label: e.target.value })}
                  placeholder="e.g. How many years of SQL experience do you have?"
                  maxLength={140}
                  disabled={saving}
                />

                <div className="flex flex-col gap-2">
                  <span className="text-sm text-ink">How important is this answer?</span>
                  <div className="flex flex-wrap gap-1.5">
                    {IMPORTANCE.map((opt) => {
                      const active = q.classification === opt.value
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={saving}
                          aria-pressed={active}
                          title={opt.hint}
                          onClick={() =>
                            update(index, {
                              classification: opt.value,
                              // Seed the rule the editor already displays, so a
                              // must-have question is never saved rule-less.
                              ...(opt.value === 'mandatory'
                                ? { rule: q.rule ?? defaultRuleFor(q.type) }
                                : { rule: undefined }),
                            })
                          }
                          className={cn(
                            'rounded-full border px-3 py-1.5 text-sm transition-colors',
                            active
                              ? 'border-brand bg-brand/10 font-semibold text-brand'
                              : 'border-slate-300 text-ink-secondary hover:bg-surface-muted',
                          )}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-xs text-ink-secondary">
                    {IMPORTANCE.find((o) => o.value === q.classification)?.hint}
                  </p>
                  <label className="flex items-center gap-1.5 text-sm text-ink">
                    <input
                      type="checkbox"
                      className="size-4 accent-brand"
                      checked={q.required}
                      onChange={(e) => update(index, { required: e.target.checked })}
                      disabled={saving}
                    />
                    Candidate must answer this to apply
                  </label>
                </div>

                {CHOICE_TYPES.has(q.type) ? (
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`opts-${index}`} className="text-sm font-medium text-ink">
                      Options (one per line)
                    </label>
                    <textarea
                      id={`opts-${index}`}
                      value={optionsText(q)}
                      onChange={(e) => setOptionsFromText(index, e.target.value)}
                      rows={Math.max(2, (q.options ?? []).length)}
                      disabled={saving}
                      className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm text-ink focus:border-brand"
                    />
                  </div>
                ) : null}

                {q.classification === 'mandatory' ? (
                  <RuleEditor
                    question={q}
                    disabled={saving}
                    onChange={(rule) => update(index, { rule })}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      {!previewMode ? (
        <>
          {/* One tap adds a common question type; rarer types stay behind a
              disclosure so the default view isn't a 12-item taxonomy. */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-ink">Add a question</span>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_TYPES.map((t) => (
                <Button
                  key={t}
                  variant="secondary"
                  size="sm"
                  onClick={() => addQuestion(t)}
                  disabled={saving || atLimit}
                >
                  + {TYPE_LABELS[t]}
                </Button>
              ))}
              <details className="relative">
                <summary className="flex h-9 cursor-pointer list-none items-center rounded-lg border border-slate-300 px-3 text-sm text-ink-secondary hover:bg-surface-muted">
                  More types
                </summary>
                <div className="absolute z-10 mt-1 flex w-60 flex-col rounded-lg border border-slate-200 bg-surface p-1 shadow-lg">
                  {QUESTION_TYPES.filter((t) => !COMMON_TYPES.includes(t)).map((t) => (
                    <button
                      key={t}
                      type="button"
                      disabled={saving || atLimit}
                      onClick={() => addQuestion(t)}
                      className="rounded-md px-2 py-2 text-left text-sm text-ink hover:bg-surface-muted disabled:text-slate-300"
                    >
                      {TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </details>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button onClick={save} loading={saving} disabled={!dirty}>
              Save questionnaire
            </Button>
          </div>
          {questions.length >= 20 ? (
            <p className="mt-2 text-xs text-warning">20 questions max (docs/17 §3.3).</p>
          ) : null}
        </>
      ) : null}

      {showRecompute && hasMandatory && !dirty ? (
        <div className="mt-4 border-t border-slate-200 pt-3">
          <Button variant="secondary" size="sm" onClick={recompute} loading={recomputing}>
            Re-run screening for existing applications
          </Button>
          <p className="mt-1 text-xs text-ink-secondary">
            Verdicts recompute for everyone except hired/rejected candidates (docs/17 §4.4).
          </p>
        </div>
      ) : null}
    </Card>
  )
}

// ── Empty state: never a blank builder (docs/17 §3) ──────────────────────────

/**
 * What the recruiter sees before any question exists. Offering a ready-made set
 * and a copy-from-another-job shortcut ahead of "start from scratch" means the
 * common path is one tap, and the blank builder is the deliberate choice rather
 * than the default.
 */
function StartFrom({
  reusable,
  disabled,
  onPick,
}: {
  reusable: ReusableQuestionnaire[]
  disabled: boolean
  onPick: (questions: QuestionValue[]) => void
}) {
  return (
    <div className="mb-3 flex flex-col gap-3 rounded-xl border border-dashed border-slate-300 bg-surface-muted/40 p-4">
      <div>
        <p className="text-sm font-medium text-ink">No questions yet</p>
        <p className="text-sm text-ink-secondary">
          Right now the apply form only asks for contact details and a resume. Add questions to sort
          candidates automatically.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {QUESTIONNAIRE_TEMPLATES.map((t: QuestionnaireTemplate) => (
          <button
            key={t.id}
            type="button"
            disabled={disabled}
            onClick={() => onPick(t.build())}
            className="rounded-lg border border-slate-300 bg-surface p-3 text-left hover:border-brand hover:bg-brand/5 disabled:opacity-50"
          >
            <span className="block text-sm font-semibold text-ink">Use {t.name.toLowerCase()}</span>
            <span className="block text-xs text-ink-secondary">{t.summary}</span>
          </button>
        ))}

        {reusable.length > 0 ? (
          <details>
            <summary className="cursor-pointer list-none rounded-lg border border-slate-300 bg-surface p-3 text-sm font-semibold text-ink hover:border-brand hover:bg-brand/5">
              Copy questions from another job
            </summary>
            <div className="mt-1 flex flex-col gap-1">
              {reusable.map((r) => (
                <button
                  key={r.job_id}
                  type="button"
                  disabled={disabled}
                  onClick={() => onPick(asDraftQuestions(r.questions))}
                  className="rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted disabled:opacity-50"
                >
                  {r.job_title}
                  <span className="ml-1 text-xs text-ink-secondary">
                    ({r.questions.length} question{r.questions.length === 1 ? '' : 's'})
                  </span>
                </button>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      <p className="text-xs text-ink-secondary">
        Or add your own below — you can edit or remove anything a template adds.
      </p>
    </div>
  )
}

// ── Candidate view preview (docs/17 §12) ──────────────────────────────────────
// Renders exactly what `sanitizeQuestions()` projects toward the public apply
// page — proof that classification/rule never leak (17 §3.4 Q7 guarantee).

function CandidatePreview({ questions }: { questions: QuestionValue[] }) {
  const publicQuestions = sanitizeQuestions(questions)

  if (publicQuestions.length === 0) {
    return (
      <p className="mb-3 rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink-secondary">
        No questions yet — candidates won&apos;t see a questionnaire on the apply form.
      </p>
    )
  }

  return (
    <div className="mb-4 flex flex-col gap-4 rounded-xl border border-dashed border-slate-300 bg-surface-muted/40 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
        What candidates see on the apply page — no rules, no mandatory/preferred markers
      </p>
      {publicQuestions.map((q) => (
        <div key={q.id} className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-ink">
            {q.required
              ? q.label || '(untitled question)'
              : `${q.label || '(untitled question)'} (optional)`}
          </label>
          <PreviewField question={q} />
        </div>
      ))}
    </div>
  )
}

const PREVIEW_FIELD_CLASS =
  'flex h-11 w-full items-center rounded-lg border border-slate-300 bg-surface px-3 text-sm text-ink-secondary'

function PreviewField({ question }: { question: PublicQuestionValue }) {
  switch (question.type) {
    case 'yes_no':
    case 'relocate':
      return (
        <div className="flex gap-2">
          {['Yes', 'No'].map((opt) => (
            <span
              key={opt}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-sm text-ink-secondary"
            >
              {opt}
            </span>
          ))}
        </div>
      )
    case 'single_choice':
      return (
        <div className="flex flex-wrap gap-2">
          {(question.options ?? []).map((o, i) => (
            <span
              key={`${o}-${i}`}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-sm text-ink-secondary"
            >
              {o || '(empty option)'}
            </span>
          ))}
        </div>
      )
    case 'multiple_choice':
      return (
        <div className="flex flex-wrap gap-2">
          {(question.options ?? []).map((o, i) => (
            <span
              key={`${o}-${i}`}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-ink-secondary"
            >
              ☐ {o || '(empty option)'}
            </span>
          ))}
        </div>
      )
    case 'dropdown':
      return (
        <div className={PREVIEW_FIELD_CLASS}>
          Select… ({(question.options ?? []).length} options)
        </div>
      )
    case 'education':
      return <div className={PREVIEW_FIELD_CLASS}>Select…</div>
    case 'number':
    case 'experience_years':
    case 'current_ctc':
    case 'expected_ctc':
      return <div className={PREVIEW_FIELD_CLASS}>0</div>
    case 'text':
    case 'location':
    default:
      return <div className={PREVIEW_FIELD_CLASS}>Candidate&apos;s answer</div>
  }
}

// ── Rule editor (PRIVATE — 17 §3.4) ───────────────────────────────────────────

function RuleEditor({
  question,
  onChange,
  disabled,
}: {
  question: QuestionValue
  onChange: (rule: RuleValue | undefined) => void
  disabled: boolean
}) {
  const rule = question.rule

  if (question.type === 'yes_no' || question.type === 'relocate') {
    const value = rule?.op === 'eq' ? rule.value : true
    return (
      <label className="flex items-center gap-2 text-sm text-ink">
        Qualifies when answered:
        <select
          value={value ? 'yes' : 'no'}
          onChange={(e) => onChange({ op: 'eq', value: e.target.value === 'yes' })}
          disabled={disabled}
          className="h-9 rounded-lg border border-slate-300 bg-surface px-2 text-sm"
        >
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
    )
  }

  if (question.type === 'single_choice' || question.type === 'dropdown') {
    const op = rule?.op === 'not_in' ? 'not_in' : 'in'
    const values = rule && 'values' in rule ? rule.values : []
    return (
      <ChoiceRuleFields
        ops={CHOICE_RULE_OPS}
        op={op}
        values={values}
        options={question.options ?? []}
        disabled={disabled}
        onOp={(next) => onChange({ op: next as 'in' | 'not_in', values })}
        onValues={(next) => onChange({ op, values: next } as RuleValue)}
        label="Answer qualifies when it:"
      />
    )
  }

  if (question.type === 'multiple_choice') {
    const op =
      rule &&
      (rule.op === 'includes_all' || rule.op === 'includes_any' || rule.op === 'includes_none')
        ? rule.op
        : 'includes_all'
    const values = rule && 'values' in rule ? rule.values : []
    return (
      <ChoiceRuleFields
        ops={MULTI_RULE_OPS}
        op={op}
        values={values}
        options={question.options ?? []}
        disabled={disabled}
        onOp={(next) => onChange({ op: next, values } as RuleValue)}
        onValues={(next) => onChange({ op, values: next } as RuleValue)}
        label="Answer qualifies when it:"
      />
    )
  }

  if (NUMERIC_TYPES.has(question.type)) {
    const draft: NumericDraft = {
      min:
        rule?.op === 'min'
          ? String(rule.value)
          : rule?.op === 'range' && rule.min !== undefined
            ? String(rule.min)
            : '',
      max:
        rule?.op === 'max'
          ? String(rule.value)
          : rule?.op === 'range' && rule.max !== undefined
            ? String(rule.max)
            : '',
    }
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink">
        <span>Qualifies when value is between</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          defaultValue={draft.min}
          placeholder="min"
          aria-label="Minimum"
          disabled={disabled}
          className="h-9 w-24 rounded-lg border border-slate-300 bg-surface px-2 text-sm"
          onBlur={(e) => commitRange(question.rule, e.target.value, 'min', onChange)}
        />
        <span>and</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          defaultValue={draft.max}
          placeholder="max"
          aria-label="Maximum"
          disabled={disabled}
          className="h-9 w-24 rounded-lg border border-slate-300 bg-surface px-2 text-sm"
          onBlur={(e) => commitRange(question.rule, e.target.value, 'max', onChange)}
        />
        <span className="text-xs text-ink-secondary">(either or both)</span>
      </div>
    )
  }

  if (question.type === 'education') {
    const level = rule?.op === 'min_level' ? rule.level : 'bachelors'
    return (
      <label className="flex items-center gap-2 text-sm text-ink">
        Minimum education:
        <select
          value={level}
          onChange={(e) => onChange({ op: 'min_level', level: e.target.value as never })}
          disabled={disabled}
          className="h-9 rounded-lg border border-slate-300 bg-surface px-2 text-sm"
        >
          {EDUCATION_LEVELS.map((l) => (
            <option key={l} value={l}>
              {EDUCATION_LABELS[l]}
            </option>
          ))}
        </select>
      </label>
    )
  }

  // text / location
  const op = rule?.op === 'contains_any' ? 'contains_any' : 'not_empty'
  const keywords = rule?.op === 'contains_any' ? rule.keywords.join(', ') : ''
  return (
    <div className="flex flex-col gap-2 text-sm text-ink">
      <label className="flex items-center gap-2">
        Answer qualifies when it:
        <select
          value={op}
          onChange={(e) =>
            e.target.value === 'contains_any'
              ? onChange({
                  op: 'contains_any',
                  keywords: keywords
                    ? keywords
                        .split(',')
                        .map((k) => k.trim())
                        .filter(Boolean)
                    : [''],
                })
              : onChange({ op: 'not_empty' })
          }
          disabled={disabled}
          className="h-9 rounded-lg border border-slate-300 bg-surface px-2 text-sm"
        >
          {TEXT_RULE_OPS.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {op === 'contains_any' ? (
        <input
          type="text"
          defaultValue={keywords}
          placeholder="keywords, comma separated"
          aria-label="Qualifying keywords"
          disabled={disabled}
          className="h-9 rounded-lg border border-slate-300 bg-surface px-2 text-sm"
          onBlur={(e) =>
            onChange({
              op: 'contains_any',
              keywords: e.target.value
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean),
            })
          }
        />
      ) : null}
    </div>
  )
}

function commitRange(
  rule: RuleValue | undefined,
  raw: string,
  side: 'min' | 'max',
  onChange: (rule: RuleValue | undefined) => void,
) {
  const currentMin = rule?.op === 'min' ? rule.value : rule?.op === 'range' ? rule.min : undefined
  const currentMax = rule?.op === 'max' ? rule.value : rule?.op === 'range' ? rule.max : undefined
  const parsed = raw.trim() === '' ? undefined : Number(raw)
  const nextMin =
    side === 'min' ? (Number.isFinite(parsed as number) ? parsed : undefined) : currentMin
  const nextMax =
    side === 'max' ? (Number.isFinite(parsed as number) ? parsed : undefined) : currentMax
  if (nextMin !== undefined && nextMax !== undefined) {
    onChange({ op: 'range', min: nextMin, max: nextMax })
  } else if (nextMin !== undefined) {
    onChange({ op: 'min', value: nextMin })
  } else if (nextMax !== undefined) {
    onChange({ op: 'max', value: nextMax })
  } else {
    onChange(undefined) // mandatory with no bounds → server flags "needs a qualifying rule"
  }
}

function ChoiceRuleFields({
  ops,
  op,
  values,
  options,
  disabled,
  onOp,
  onValues,
  label,
}: {
  ops: Array<{ op: RuleValue['op']; label: string }>
  op: string
  values: string[]
  options: string[]
  disabled: boolean
  onOp: (next: string) => void
  onValues: (next: string[]) => void
  label: string
}) {
  return (
    <div className="flex flex-col gap-2 text-sm text-ink">
      <label className="flex items-center gap-2">
        {label}
        <select
          value={op}
          onChange={(e) => onOp(e.target.value)}
          disabled={disabled}
          className="h-9 rounded-lg border border-slate-300 bg-surface px-2 text-sm"
        >
          {ops.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        {options.filter(Boolean).map((option) => {
          const checked = values.includes(option)
          return (
            <label
              key={option}
              className={`rounded-full border px-2.5 py-1 text-xs ${
                checked
                  ? 'border-brand bg-brand/10 font-medium text-brand'
                  : 'border-slate-300 text-ink-secondary'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                disabled={disabled}
                onChange={() =>
                  onValues(checked ? values.filter((v) => v !== option) : [...values, option])
                }
              />
              {option}
            </label>
          )
        })}
      </div>
    </div>
  )
}
