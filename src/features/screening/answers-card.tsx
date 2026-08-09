import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Badge } from '@/ui/badge'
import type { AnswerView } from '@/features/screening/server'
import type { ScreeningStatusValue } from '@/features/screening/schemas'
import { EDUCATION_LABELS, type EducationLevelValue } from '@/features/screening/schemas'

/**
 * Questionnaire answers card on application detail — docs/17 §12.
 * Recruiter-only (never rendered on public surfaces); shows the deterministic
 * verdict badge, which the AI can never write (17 §14).
 */

const VERDICT_BADGE: Record<
  ScreeningStatusValue,
  { tone: 'success' | 'danger' | 'warning'; label: string }
> = {
  qualified: { tone: 'success', label: 'Qualified ✓' },
  does_not_meet_mandatory: { tone: 'danger', label: 'Doesn’t meet mandatory criteria' },
  review_required: { tone: 'warning', label: 'Needs review' },
}

function formatValue(view: AnswerView): string {
  const v = view.answer
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (Array.isArray(v)) return v.join(', ')
  if (typeof v === 'number') {
    if (view.type === 'current_ctc' || view.type === 'expected_ctc') {
      return `${v.toLocaleString('en-IN')} /yr`
    }
    if (view.type === 'experience_years') return `${v} yrs`
    return String(v)
  }
  if (view.type === 'education' && typeof v === 'string') {
    return EDUCATION_LABELS[v as EducationLevelValue] ?? v
  }
  return String(v ?? '')
}

export function AnswersCard({
  answers,
  screeningStatus,
}: {
  answers: AnswerView[]
  screeningStatus: ScreeningStatusValue | null
}) {
  if (answers.length === 0 && !screeningStatus) return null
  const verdict = screeningStatus ? VERDICT_BADGE[screeningStatus] : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Questionnaire</CardTitle>
        {verdict ? <Badge tone={verdict.tone}>{verdict.label}</Badge> : null}
      </CardHeader>
      {answers.length === 0 ? (
        <p className="text-sm text-ink-secondary">No questionnaire answers were recorded.</p>
      ) : (
        <dl className="flex flex-col gap-3">
          {answers.map((a) => (
            <div key={a.question_id}>
              <dt className="text-xs text-ink-secondary">
                {a.label ?? 'Question removed from form'}
              </dt>
              <dd className="text-sm font-medium text-ink">{formatValue(a)}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  )
}
