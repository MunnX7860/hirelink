'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Button } from '@/ui/button'
import { Badge } from '@/ui/badge'
import { Input } from '@/ui/input'
import { Select } from '@/ui/select'
import { Textarea } from '@/ui/textarea'
import { ApiError, api, mutate } from '@/lib/api-client'
import { relativeTime } from '@/lib/time'
import { useToast } from '@/ui/toaster'
import {
  INSUFFICIENT_EVIDENCE,
  MAX_INSTRUCTION_CHARS,
  MAX_RESULTS_CAP,
  canCancelSession,
  canRetrySession,
  type ResultCategoryValue,
} from '@/features/screening/session-schemas'
import type {
  ScreeningCounters,
  SessionDetail,
  SessionSummary,
} from '@/features/screening/sessions'
import type { DisplayResultRow } from '@/features/screening/session-schemas'

/**
 * Screening dashboard at /dashboard/jobs/:id/screening — docs/17 §12 + docs/06.
 * New-session form (pool picker w/ live counts, instruction, max-N), append-only
 * sessions list with live progress, results grouped by category with expandable
 * reasons/evidence/uncertainties. AI write = never touches applications.status (§14).
 */

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'muted'> = {
  queued: 'muted',
  processing: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'muted',
  quota_limited: 'warning',
}

const CATEGORY_LABEL: Record<ResultCategoryValue, string> = {
  strong_match: 'Strong match',
  possible_match: 'Possible match',
  review_required: 'Needs review',
  lower_priority: 'Lower priority',
}

const POOL_LABEL: Record<string, string> = {
  qualified: 'Qualified only',
  review_required: 'Needs review only',
  qualified_review: 'Qualified + needs review',
  all_non_archived: 'All non-archived',
}

function uncertaintyText(u: string): string {
  if (u.startsWith(INSUFFICIENT_EVIDENCE)) {
    const note = u
      .slice(INSUFFICIENT_EVIDENCE.length)
      .trim()
      .replace(/^[:\-–]\s*/, '')
    return note ? `Not clear from resume — ${note}` : 'Not clear from resume'
  }
  return u
}

// ── Result card (expandable §12) ──────────────────────────────────────────────

function ResultCard({ row, position }: { row: DisplayResultRow; position?: number | undefined }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center gap-2 p-3">
        {position !== undefined ? (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-sm font-bold text-brand">
            {position}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <Link
            href={`/dashboard/applications/${row.applicationId}`}
            className="block truncate text-sm font-medium text-brand hover:underline"
          >
            {row.applicantName}
          </Link>
          <p className="text-xs text-ink-secondary">
            {CATEGORY_LABEL[row.category ?? 'review_required']}
            {row.score !== null ? ` · score ${row.score}` : ''}
          </p>
        </div>
        {row.score !== null ? (
          <span title="AI prioritization score — not a probability" className="cursor-help">
            <Badge tone="muted">AI score {row.score}</Badge>
          </span>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Hide reasoning' : 'Show reasoning'}
          onClick={() => setOpen((v) => !v)}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-slate-100"
        >
          <span
            aria-hidden
            className={`inline-block transition-transform ${open ? 'rotate-180' : ''}`}
          >
            ▾
          </span>
        </button>
      </div>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-slate-100 p-3 pt-3">
          {row.reasons.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                Why
              </p>
              <ul className="flex flex-col gap-1">
                {row.reasons.map((r, i) => (
                  <li key={i} className="flex gap-2 text-sm text-ink">
                    <span aria-hidden>•</span> {r}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {row.evidence.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                Evidence
              </p>
              <ul className="flex flex-col gap-1">
                {row.evidence.map((e, i) => (
                  <li key={i} className="flex gap-2 text-sm text-ink-secondary">
                    <span aria-hidden>“</span>
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {row.uncertainties.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-warning">Gaps</p>
              <ul className="flex flex-col gap-1">
                {row.uncertainties.map((u, i) => (
                  <li key={i} className="flex gap-2 text-sm text-ink-secondary">
                    <span aria-hidden>?</span> {uncertaintyText(u)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ResultGroup({
  title,
  tone,
  rows,
  positions,
}: {
  title: string
  tone: 'success' | 'warning' | 'danger' | 'muted'
  rows: DisplayResultRow[]
  positions?: Map<string, number>
}) {
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold text-ink">{title}</p>
        <Badge tone={tone}>{rows.length}</Badge>
      </div>
      {rows.map((r) => (
        <ResultCard key={r.applicationId} row={r} position={positions?.get(r.applicationId)} />
      ))}
    </div>
  )
}

// ── Session card with expandable detail + live polling ────────────────────────

function SessionItem({ session, onChanged }: { session: SessionSummary; onChanged: () => void }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<'retry' | 'cancel' | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const active = session.status === 'queued' || session.status === 'processing'

  const load = useCallback(async () => {
    try {
      const res = await api<SessionDetail>(`/api/ai/screenings/${session.id}`)
      setDetail(res)
      setError(null)
      return res
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t load this session.')
      return null
    }
  }, [session.id])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      const res = await load()
      const stillActive = res?.session.status === 'queued' || res?.session.status === 'processing'
      if (!cancelled && stillActive) timer = setTimeout(tick, 3000)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [open, load])

  const positions = new Map<string, number>()
  detail?.results.shortlist.forEach((r, i) => positions.set(r.applicationId, i + 1))

  // 17 §9.3 — retry ONLY failed rows (never the whole pool); cancel frees the job.
  const retryable =
    canRetrySession(session.status) && (session.failed > 0 || session.status === 'failed')
  const cancellable = canCancelSession(session.status)

  async function doRetry() {
    setActionBusy('retry')
    try {
      await mutate(`/api/ai/screenings/${session.id}/retry`, 'POST')
      toast('Screening resumes — unscreened candidates go first in line.', { tone: 'success' })
      onChanged()
      if (open) void load()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t retry — try again.', {
        tone: 'danger',
      })
    } finally {
      setActionBusy(null)
    }
  }

  async function doCancel() {
    // Two-tap confirm (mobile-first — no fragile modal for a reversible action).
    if (!confirmCancel) {
      setConfirmCancel(true)
      setTimeout(() => setConfirmCancel(false), 4000)
      return
    }
    setConfirmCancel(false)
    setActionBusy('cancel')
    try {
      await mutate(`/api/ai/screenings/${session.id}/cancel`, 'POST')
      toast('Screening stopped — retry revives it anytime.', { tone: 'success' })
      onChanged()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Couldn’t stop it — try again.', {
        tone: 'danger',
      })
    } finally {
      setActionBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{session.instruction}</p>
          <p className="text-xs text-ink-secondary">
            {POOL_LABEL[session.pool]} · top {session.max_results} · by {session.created_by_name} ·{' '}
            {relativeTime(session.created_at)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {session.engine === 'batch' ? (
            <span title="Screening via Gemini Batch — large-pool accelerator">
              <Badge tone="muted">Batch</Badge>
            </span>
          ) : null}
          <Badge tone={STATUS_TONE[session.status] ?? 'muted'}>
            {session.status === 'quota_limited' ? 'quota paused' : session.status}
          </Badge>
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Collapse session' : 'Expand session'}
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
        </div>
      </div>

      {/* Live progress (17 §12: "127 / 500 processed") */}
      {active || session.processed > 0 || session.failed > 0 ? (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full transition-all ${session.status === 'failed' ? 'bg-danger' : 'bg-brand'}`}
              style={{
                width: `${session.pool_size === 0 ? 0 : Math.min(100, Math.round(((session.processed + session.failed) / session.pool_size) * 100))}%`,
              }}
            />
          </div>
          <p className="mt-1 text-xs text-ink-secondary">
            {active
              ? `${session.processed} / ${session.pool_size} processed`
              : session.status === 'quota_limited'
                ? `Paused at ${session.processed} / ${session.pool_size} — resumes automatically`
                : `${session.processed} screened${session.failed > 0 ? ` · ${session.failed} failed` : ''}`}
          </p>
        </div>
      ) : null}

      {/* Session actions (17 §9.3): retry failed-only / stop in-flight / Drive artifact */}
      {retryable || cancellable || session.summary_file_id ? (
        <div className="flex flex-wrap items-center gap-2">
          {session.summary_file_id ? (
            <a
              href={`https://drive.google.com/file/d/${session.summary_file_id}/view`}
              target="_blank"
              rel="noreferrer"
              title="Immutable JSON summary of this session in your Drive (AI Screenings folder)"
              className="inline-flex h-9 items-center text-sm font-medium text-brand hover:underline"
            >
              Summary in Drive ↗
            </a>
          ) : null}
          {retryable ? (
            <Button
              size="sm"
              variant="secondary"
              loading={actionBusy === 'retry'}
              disabled={actionBusy !== null}
              onClick={() => void doRetry()}
            >
              {session.failed > 0 ? `Retry ${session.failed} failed` : 'Resume screening'}
            </Button>
          ) : null}
          {cancellable ? (
            <Button
              size="sm"
              variant={confirmCancel ? 'danger' : 'ghost'}
              loading={actionBusy === 'cancel'}
              disabled={actionBusy !== null}
              onClick={() => void doCancel()}
            >
              {confirmCancel ? 'Tap again to stop' : 'Stop'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-4 border-t border-slate-100 pt-3">
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          {!detail ? (
            <p className="text-sm text-ink-secondary">Loading results…</p>
          ) : (
            <>
              {detail.results.pendingCount > 0 ? (
                <p className="text-sm text-ink-secondary">
                  {detail.results.pendingCount} candidates still in the queue…
                </p>
              ) : null}
              {detail.results.shortlist.length > 0 ? (
                <ResultGroup
                  title="Shortlist"
                  tone="success"
                  rows={detail.results.shortlist}
                  positions={positions}
                />
              ) : detail.session.status === 'completed' ? (
                <p className="text-sm text-ink-secondary">
                  No strong or possible matches cleared the bar this run — nothing was padded to
                  fill top {detail.session.max_results}.
                </p>
              ) : null}
              <ResultGroup
                title="Beyond top-N (still matched)"
                tone="muted"
                rows={detail.results.beyondTopN}
              />
              <ResultGroup
                title="Needs your review"
                tone="warning"
                rows={detail.results.review_required}
              />
              <ResultGroup
                title="Lower priority"
                tone="muted"
                rows={detail.results.lower_priority}
              />
              {detail.results.failed.length > 0 ? (
                <ResultGroup title="Failed to screen" tone="danger" rows={detail.results.failed} />
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export function ScreeningDashboard({
  jobId,
  aiConfigured,
  counters,
  initialSessions,
}: {
  jobId: string
  aiConfigured: boolean
  counters: ScreeningCounters
  initialSessions: SessionSummary[]
}) {
  const toast = useToast()
  const [sessions, setSessions] = useState(initialSessions)
  const [pool, setPool] = useState('qualified')
  const [instruction, setInstruction] = useState('')
  const [maxResults, setMaxResults] = useState('20')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshList = useCallback(async () => {
    try {
      const res = await api<{ sessions: SessionSummary[] }>(`/api/ai/screenings?job_id=${jobId}`)
      setSessions(res.sessions)
      return res.sessions
    } catch {
      return null
    }
  }, [jobId])

  // List-level poll while any session is active (progress + others' sessions).
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const active = sessions.some((s) => s.status === 'queued' || s.status === 'processing')
    if (!active) return
    pollRef.current = setTimeout(async () => {
      await refreshList()
    }, 3000)
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [sessions, refreshList])

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const maxResultsValue = Number.parseInt(maxResults, 10)
      await mutate('/api/ai/screenings', 'POST', {
        job_id: jobId,
        pool,
        instruction: instruction.trim(),
        max_results: Number.isFinite(maxResultsValue) ? maxResultsValue : 0,
      })
      toast('Screening started — progress updates live below.', { tone: 'success' })
      setInstruction('')
      await refreshList()
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        const fieldErr = err.fieldError('instruction') ?? err.fieldError('max_results')
        if (fieldErr) setError(fieldErr)
      } else {
        setError('Couldn’t start the screening — try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  const poolCounts: Record<string, number> = {
    qualified: counters.qualified,
    review_required: counters.review_required,
    qualified_review: counters.qualified + counters.review_required,
    all_non_archived: counters.total,
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Pool counters (17 §12) */}
      <Card>
        <CardHeader>
          <CardTitle>Screening pool</CardTitle>
        </CardHeader>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {(
            [
              ['Qualified', counters.qualified, 'success'],
              ['Needs review', counters.review_required, 'warning'],
              ['DNMC', counters.does_not_meet_mandatory, 'danger'],
              ['Unscreened', counters.unscreened, 'muted'],
              ['Total', counters.total, 'muted'],
            ] as const
          ).map(([label, value, tone]) => (
            <div
              key={label}
              className="flex min-w-20 flex-col items-center rounded-lg bg-surface-muted px-3 py-2"
            >
              <span className="text-lg font-bold text-ink">{value}</span>
              <span
                className={`text-[11px] uppercase tracking-wide ${tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning' : tone === 'danger' ? 'text-danger' : 'text-ink-secondary'}`}
              >
                {label}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* New session form — visible-but-explained when unconfigured (10 §6) */}
      <Card>
        <CardHeader>
          <CardTitle>New AI screening</CardTitle>
          <Badge tone="muted">Gemini · your key</Badge>
        </CardHeader>
        {!aiConfigured ? (
          <p className="text-sm text-ink-secondary">
            AI screening needs your Gemini key first — add it in{' '}
            <Link href="/dashboard/settings" className="font-medium text-brand">
              Settings → AI
            </Link>
            . Questionnaire screening keeps working regardless.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <Select
              id="screen-pool"
              label="Who should be screened?"
              value={pool}
              onChange={(e) => setPool(e.target.value)}
            >
              {Object.entries(POOL_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label} ({poolCounts[value] ?? 0})
                </option>
              ))}
            </Select>
            <Textarea
              label="What should the AI look for?"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder='e.g. "healthcare background, SQL + Power BI, night-shift friendly"'
              maxLength={MAX_INSTRUCTION_CHARS}
              rows={3}
              hint={`${instruction.length}/${MAX_INSTRUCTION_CHARS} — candidates' resumes, answers and profiles are packed automatically.`}
            />
            <Input
              label={`Show up to how many? (1–${MAX_RESULTS_CAP})`}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_RESULTS_CAP}
              value={maxResults}
              onChange={(e) => setMaxResults(e.target.value)}
              hint="An upper bound, never a quota — the AI may clear fewer."
            />
            {error ? (
              <p role="alert" className="rounded-lg bg-danger/10 p-2 text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div>
              <Button
                loading={busy}
                disabled={instruction.trim().length < 3}
                onClick={() => void submit()}
              >
                Start screening
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Sessions (append-only history, 17 §14.4) */}
      <Card>
        <CardHeader>
          <CardTitle>Sessions ({sessions.length})</CardTitle>
        </CardHeader>
        {sessions.length === 0 ? (
          <p className="text-sm text-ink-secondary">
            No screenings yet — start one above. Results keep their reasons & evidence forever.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((s) => (
              <SessionItem key={s.id} session={s} onChanged={() => void refreshList()} />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
