'use client'

import { useState } from 'react'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Button } from '@/ui/button'
import { Badge } from '@/ui/badge'
import { ApiError, mutate } from '@/lib/api-client'
import { relativeTime } from '@/lib/time'
import type { ParsedResume } from '@/features/ai/schemas'

export interface InitialSummary {
  summary: string
  strengths: string[]
  generated_at: string
}

/**
 * AI panel on the application detail — docs/10 §3 (summary + resume parsing)
 * with docs/10 §6 degradation and docs/06 §4: the whole slot is HIDDEN when no
 * AI integration is configured.
 */
export function AiPanel({
  applicantId,
  resumeId,
  initialSummary,
}: {
  applicantId: string
  resumeId: string | null
  initialSummary: InitialSummary | null
}) {
  const [summary, setSummary] = useState<InitialSummary | null>(initialSummary)
  const [parsed, setParsed] = useState<ParsedResume | null>(null)
  const [busy, setBusy] = useState<'summary' | 'parse' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function summarize(force: boolean) {
    setBusy('summary')
    setError(null)
    try {
      const res = await mutate<InitialSummary & { cached: boolean }>(
        '/api/ai/summarize-applicant',
        'POST',
        { applicant_id: applicantId, force },
      )
      setSummary({ summary: res.summary, strengths: res.strengths, generated_at: res.generated_at })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t summarise this candidate.')
    } finally {
      setBusy(null)
    }
  }

  async function parseResume() {
    if (!resumeId) return
    setBusy('parse')
    setError(null)
    try {
      const res = await mutate<{ parsed: ParsedResume; cached: boolean }>(
        '/api/ai/parse-resume',
        'POST',
        { resume_id: resumeId },
      )
      setParsed(res.parsed)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t parse this resume.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI snapshot</CardTitle>
        <Badge tone="muted">Gemini · your key</Badge>
      </CardHeader>

      {error ? (
        <p role="alert" className="mb-3 rounded-lg bg-danger/10 p-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* Candidate summary (docs/10 §3: ≤120 words + 3 strengths, cached) */}
      {summary ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-6 text-ink">{summary.summary}</p>
          <ul className="flex flex-col gap-1">
            {summary.strengths.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm text-ink-secondary">
                <span aria-hidden>•</span> {s}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between">
            <p className="text-xs text-ink-secondary">
              Generated {summary.generated_at ? relativeTime(summary.generated_at) : 'earlier'}
            </p>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === 'summary'}
              onClick={() => void summarize(true)}
            >
              Regenerate
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink-secondary">
            One tap turns the resume + notes into a 120-word snapshot with strengths.
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'summary'}
            onClick={() => void summarize(false)}
          >
            Summarize candidate
          </Button>
        </div>
      )}

      {/* Resume parsing (docs/10 §3: ParsedResume, cached on resumes.ai_parsed) */}
      {resumeId ? (
        <div className="mt-4 border-t border-slate-100 pt-3">
          {parsed ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">
                  {parsed.headline ?? 'Parsed resume'}
                </p>
                {parsed.experience_years !== null ? (
                  <Badge tone="muted">{parsed.experience_years} yrs</Badge>
                ) : null}
              </div>
              {parsed.skills.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {parsed.skills.map((skill) => (
                    <span
                      key={skill}
                      className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              ) : null}
              {parsed.experience.length > 0 ? (
                <ul className="flex flex-col gap-0.5 text-xs text-ink-secondary">
                  {parsed.experience.slice(0, 3).map((e, i) => (
                    <li key={i}>
                      {e.title}
                      {e.company ? ` · ${e.company}` : ''}
                      {e.months ? ` (${e.months} mo)` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-xs italic text-ink-secondary">{parsed.summary}</p>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              loading={busy === 'parse'}
              onClick={() => void parseResume()}
            >
              Parse resume details
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  )
}
