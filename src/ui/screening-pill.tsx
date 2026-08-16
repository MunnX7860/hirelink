import { cn } from '@/lib/utils'
import type { ScreeningStatusValue } from '@/features/screening/schemas'

/**
 * ScreeningPill — the questionnaire verdict, in recruiter language.
 *
 * Deliberately NOT the raw enum: `does_not_meet_mandatory` means nothing to
 * someone who didn't write the schema. Same shape/size discipline as StatusPill
 * (docs/06 §3) but outlined rather than filled, so a row carrying both pills
 * reads as "pipeline status" + "screening result" instead of two competing
 * status chips. Text is always present — never colour-only (docs/06 §6).
 */
const VERDICTS: Record<ScreeningStatusValue, { label: string; tone: string }> = {
  qualified: { label: 'Qualified', tone: 'border-success/40 bg-success/5 text-success' },
  does_not_meet_mandatory: {
    label: 'Not qualified',
    tone: 'border-status-rejected/40 bg-status-rejected/5 text-status-rejected',
  },
  review_required: {
    label: 'Needs review',
    tone: 'border-warning/40 bg-warning/5 text-warning',
  },
}

export function ScreeningPill({
  verdict,
  className,
}: {
  /** null/undefined = job has no mandatory questionnaire; render nothing. */
  verdict: ScreeningStatusValue | null | undefined
  className?: string
}) {
  if (!verdict) return null
  const { label, tone } = VERDICTS[verdict]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide',
        tone,
        className,
      )}
    >
      {label}
    </span>
  )
}
