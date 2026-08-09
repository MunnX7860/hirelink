'use client'

import { useState } from 'react'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Button } from '@/ui/button'
import { Badge } from '@/ui/badge'
import { ApiError, mutate } from '@/lib/api-client'
import { relativeTime } from '@/lib/time'
import type { ResumeProfile } from '@/features/ai/schemas'

export interface ProfileView {
  profile: ResumeProfile | null
  updated_at: string | null
  stale: boolean
  buildable: boolean
}

function formatMonths(months: number | null): string | null {
  if (months === null || months <= 0) return null
  const years = Math.floor(months / 12)
  const rest = months % 12
  if (years === 0) return `${rest} mo`
  return rest === 0 ? `${years} yr` : `${years} yr ${rest} mo`
}

function formatCtc(value: number | null): string | null {
  if (value === null) return null
  return `${value.toLocaleString('en-IN')}/yr`
}

/**
 * "Parsed profile" card on the applicant profile page — docs/17 §6.
 * Collapsed by default once a profile exists; the empty state starts open
 * so the Build action is visible. Hidden entirely when AI is unconfigured
 * (the page only renders it behind that gate — docs/10 §6).
 */
export function ProfileCard({
  applicantId,
  initial,
}: {
  applicantId: string
  initial: ProfileView
}) {
  const [view, setView] = useState(initial)
  const [open, setOpen] = useState(initial.profile === null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function build() {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const res = await mutate<{ profile: ResumeProfile; cached: boolean; updated_at: string }>(
        '/api/ai/applicant-profile',
        'POST',
        { applicant_id: applicantId },
      )
      setView({ profile: res.profile, updated_at: res.updated_at, stale: false, buildable: true })
      setOpen(true)
      setNote(
        res.cached
          ? 'Already up to date — no AI credit used.'
          : 'Profile built from the latest resume.',
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t build a profile from this resume.')
    } finally {
      setBusy(false)
    }
  }

  const p = view.profile
  const facts: string[] = []
  if (p) {
    if (p.total_experience_years !== null) facts.push(`${p.total_experience_years} yrs experience`)
    if (p.location) facts.push(p.location)
    if (p.notice_period) facts.push(`Notice: ${p.notice_period}`)
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <CardHeader>
          <CardTitle>Parsed profile</CardTitle>
          <Badge tone="muted">Gemini · your key</Badge>
          {p && view.stale ? <Badge tone="warning">outdated</Badge> : null}
          {p && !open ? (
            <p className="mt-0.5 text-xs text-ink-secondary">
              {p.total_experience_years !== null ? `${p.total_experience_years} yrs · ` : ''}
              {p.skills.slice(0, 3).join(', ') || 'profile ready'}
            </p>
          ) : null}
        </CardHeader>
        {p ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Collapse profile' : 'Expand profile'}
            onClick={() => setOpen((v) => !v)}
            className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-slate-100"
          >
            <span
              aria-hidden
              className={`inline-block transition-transform ${open ? 'rotate-180' : ''}`}
            >
              ▾
            </span>
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mb-3 rounded-lg bg-danger/10 p-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {note ? <p className="mb-3 text-xs text-ink-secondary">{note}</p> : null}

      {!p ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-ink-secondary">
            One tap reads the latest resume into a structured profile — employers, skills, tools,
            education, and more — reused later for screening.{' '}
            {view.buildable ? '' : 'It needs an uploaded resume first.'}
          </p>
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={!view.buildable}
            onClick={() => void build()}
          >
            Build profile
          </Button>
        </div>
      ) : open ? (
        <div className="flex flex-col gap-4">
          {facts.length > 0 ? (
            <p className="text-sm font-medium text-ink">{facts.join(' · ')}</p>
          ) : null}

          {p.current_ctc !== null || p.expected_ctc !== null ? (
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-secondary">
              {p.current_ctc !== null ? (
                <div className="flex gap-1.5">
                  <dt className="text-xs uppercase tracking-wide">Current CTC</dt>
                  <dd className="text-ink">{formatCtc(p.current_ctc)}</dd>
                </div>
              ) : null}
              {p.expected_ctc !== null ? (
                <div className="flex gap-1.5">
                  <dt className="text-xs uppercase tracking-wide">Expected CTC</dt>
                  <dd className="text-ink">{formatCtc(p.expected_ctc)}</dd>
                </div>
              ) : null}
              <span className="text-xs">(as stated on the resume)</span>
            </dl>
          ) : null}

          {p.skills.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                Skills
              </p>
              <div className="flex flex-wrap gap-1.5">
                {p.skills.map((skill) => (
                  <span
                    key={skill}
                    className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {p.tools.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                Tools
              </p>
              <div className="flex flex-wrap gap-1.5">
                {p.tools.map((tool) => (
                  <span
                    key={tool}
                    className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-ink"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {p.employers.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                Experience
              </p>
              <ul className="flex flex-col gap-1.5">
                {p.employers.map((e, i) => (
                  <li key={i} className="text-sm text-ink">
                    <span className="font-medium">{e.title ?? 'Role'}</span>
                    {' · '}
                    {e.name}
                    {formatMonths(e.months) ? (
                      <span className="text-ink-secondary"> ({formatMonths(e.months)})</span>
                    ) : null}
                    {e.industry ? (
                      <span className="text-ink-secondary"> · {e.industry}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {p.education.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                Education
              </p>
              <ul className="flex flex-col gap-1 text-sm text-ink">
                {p.education.map((e, i) => (
                  <li key={i}>
                    {e.degree}
                    {e.institution ? ` · ${e.institution}` : ''}
                    {e.year ? ` (${e.year})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {p.responsibilities_summary ? (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                What they did
              </p>
              <p className="text-sm leading-6 text-ink-secondary">{p.responsibilities_summary}</p>
            </div>
          ) : null}

          {p.projects.length > 0 ? (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                Projects
              </p>
              <ul className="flex flex-col gap-1 text-sm text-ink">
                {p.projects.map((proj, i) => (
                  <li key={i}>
                    <span className="font-medium">{proj.name}</span>
                    {proj.summary ? (
                      <span className="text-ink-secondary"> — {proj.summary}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t border-slate-100 pt-3">
            <p className="text-xs text-ink-secondary">
              Built {view.updated_at ? relativeTime(view.updated_at) : 'earlier'} · prompt v1
            </p>
            <Button variant="ghost" size="sm" loading={busy} onClick={() => void build()}>
              Re-build
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
