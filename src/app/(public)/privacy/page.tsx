import type { Metadata } from 'next'
import { Card } from '@/ui/card'

export const metadata: Metadata = { title: 'Privacy' }

/**
 * Public privacy note — docs/06 §4 (public screen table: apply-page footer links
 * here). Plain-language summary of docs/00 D1–D3 + docs/04 §8 data lifecycle;
 * not a substitute for the employer's own privacy policy.
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-lg p-4 pt-8">
      <Card className="flex flex-col gap-4">
        <h1 className="text-xl font-bold text-ink">How your application data is handled</h1>
        <p className="text-sm leading-6 text-ink-secondary">
          When you apply through a HireLink hiring link, your details go directly to the employer
          you applied to — not to any other company.
        </p>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">Your resume</h2>
          <p className="text-sm leading-6 text-ink-secondary">
            Your resume file is stored in the employer&apos;s own Google Drive, not on a shared
            HireLink server. There is never a public link to it — only the employer (and people
            they&apos;ve given access to their hiring workspace) can open it, through an
            authenticated request each time.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">Your contact details and answers</h2>
          <p className="text-sm leading-6 text-ink-secondary">
            Your name, email, phone number, and any screening question answers are stored in the
            employer&apos;s hiring workspace so they can review your application and, if they
            choose, get in touch. This data is never sold, and it is never used to train AI models.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">If the employer uses AI screening</h2>
          <p className="text-sm leading-6 text-ink-secondary">
            Some employers use an optional AI assistant (their own API key, not HireLink&apos;s) to
            help summarize or shortlist applications. AI-generated notes are advisory only — hiring
            decisions and pipeline status are always made by a person, never automatically by AI.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-ink">Removing your data</h2>
          <p className="text-sm leading-6 text-ink-secondary">
            To ask an employer to remove your application data, contact them directly — the
            confirmation email you received after applying includes the job you applied to, which
            identifies the employer&apos;s workspace.
          </p>
        </div>
      </Card>
    </div>
  )
}
