'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api-client'
import { ApplicationCard } from '@/features/applications/application-card'
import { BulkActionsBar } from '@/features/applications/bulk-actions-bar'
import { IconSearch } from '@/ui/icons'
import { Select } from '@/ui/select'
import { cn } from '@/lib/utils'
import { APPLICATION_STATUSES, type ApplicationStatusValue } from '@/features/applications/schemas'
import type { ApplicationListItem } from '@/features/applications/server'
import type { TagRow } from '@/features/applicants/schemas'

export interface ExplorerFilters {
  q: string
  statuses: Set<ApplicationStatusValue>
  jobId: string
  tagId: string
  dateFrom: string
  dateTo: string
}

/**
 * ApplicationExplorer — Inbox/filtered applications list (docs/02 §5–6).
 * Server-side filters per docs/05 §4.3 (job/status/tags/date range/free-text q),
 * cursor "Load more", bulk selection (docs/02 §6).
 */
export function ApplicationExplorer({
  initialItems,
  initialCursor,
  jobs,
  tags,
  inboxDefault,
  fixedJobId,
}: {
  initialItems: ApplicationListItem[]
  initialCursor: string | null
  jobs: Array<{ id: string; title: string }>
  tags: TagRow[]
  /** Inbox default = status:new (docs/05 §4.3); filtered views pass false. */
  inboxDefault: boolean
  /** When set, the job filter is locked (job-scoped views). */
  fixedJobId?: string | undefined
}) {
  const [filters, setFilters] = useState<ExplorerFilters>({
    q: '',
    statuses: new Set<ApplicationStatusValue>(),
    jobId: fixedJobId ?? '',
    tagId: '',
    dateFrom: '',
    dateTo: '',
  })
  const [items, setItems] = useState(initialItems)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)

  const buildParams = useCallback(
    (f: ExplorerFilters, c: string | null) => {
      const p = new URLSearchParams()
      if (f.jobId) p.set('job_id', f.jobId)
      if (f.statuses.size > 0) p.set('status', [...f.statuses].join(','))
      else if (!inboxDefault) p.set('status', APPLICATION_STATUSES.join(','))
      if (f.q.trim()) p.set('q', f.q.trim())
      if (f.tagId) p.set('tag_id', f.tagId)
      if (f.dateFrom) p.set('date_from', f.dateFrom)
      if (f.dateTo) p.set('date_to', f.dateTo)
      if (c) p.set('cursor', c)
      return p
    },
    [inboxDefault],
  )

  const filtersRef = useRef(filters)
  filtersRef.current = filters
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchPage = useCallback(
    async (f: ExplorerFilters, c: string | null, append: boolean) => {
      setLoading(true)
      setError(null)
      try {
        const res = await api<{ data: ApplicationListItem[]; next_cursor: string | null }>(
          `/api/applications?${buildParams(f, c)}`,
        )
        setItems((prev) => (append ? [...prev, ...res.data] : res.data))
        setCursor(res.next_cursor)
      } catch {
        setError('Could not load applications.')
      } finally {
        setLoading(false)
      }
    },
    [buildParams],
  )

  // Refetch first page when filters change (debounced for typing).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void fetchPage(filtersRef.current, null, false), 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [filters, fetchPage])

  // ── Bulk selection (docs/02 §6) ──────────────────────────────────────────────
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function exitSelection() {
    setSelecting(false)
    setSelected(new Set())
  }

  function toggleStatus(s: ApplicationStatusValue) {
    setFilters((f) => {
      const statuses = new Set(f.statuses)
      if (statuses.has(s)) statuses.delete(s)
      else statuses.add(s)
      return { ...f, statuses }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Search + filter toggle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-secondary" />
          <label htmlFor="app-search" className="sr-only">
            Search name or email
          </label>
          <input
            id="app-search"
            type="search"
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Search name or email…"
            className="h-11 w-full rounded-lg border border-slate-300 bg-surface pl-9 pr-3 text-base text-ink focus:border-brand focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          className={cn(
            'h-11 shrink-0 rounded-lg border px-3 text-sm font-medium',
            showFilters || filters.jobId || filters.tagId || filters.dateFrom || filters.dateTo
              ? 'border-brand text-brand'
              : 'border-slate-300 text-ink-secondary',
          )}
        >
          Filters
        </button>
        <button
          type="button"
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
          className={cn(
            'h-11 shrink-0 rounded-lg border px-3 text-sm font-medium',
            selecting ? 'border-brand text-brand' : 'border-slate-300 text-ink-secondary',
          )}
        >
          {selecting ? 'Done' : 'Select'}
        </button>
      </div>

      {/* Status chips (multi) */}
      <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Status filter">
        {APPLICATION_STATUSES.filter((s) => s !== 'archived' || filters.statuses.has(s)).map(
          (s) => {
            const active = filters.statuses.has(s)
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => toggleStatus(s)}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide',
                  active
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-slate-300 text-ink-secondary',
                )}
              >
                {s}
              </button>
            )
          },
        )}
      </div>

      {showFilters ? (
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-surface-muted p-3 sm:grid-cols-4">
          {!fixedJobId ? (
            <Select
              label="Job"
              wrapperClassName="flex flex-col gap-1"
              labelClassName="text-xs font-medium text-ink-secondary"
              value={filters.jobId}
              onChange={(e) => setFilters((f) => ({ ...f, jobId: e.target.value }))}
              className="h-10 text-sm"
            >
              <option value="">All jobs</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </Select>
          ) : null}
          <Select
            label="Tag"
            wrapperClassName="flex flex-col gap-1"
            labelClassName="text-xs font-medium text-ink-secondary"
            value={filters.tagId}
            onChange={(e) => setFilters((f) => ({ ...f, tagId: e.target.value }))}
            className="h-10 text-sm"
          >
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-secondary">
            From
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
              className="h-10 rounded-lg border border-slate-300 bg-surface px-2 text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-secondary">
            To
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
              className="h-10 rounded-lg border border-slate-300 bg-surface px-2 text-sm text-ink"
            />
          </label>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
          {error}{' '}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => void fetchPage(filtersRef.current, null, false)}
          >
            Retry
          </button>
        </div>
      ) : null}

      {items.length === 0 && !loading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">
          No applications match these filters.
        </p>
      ) : (
        items.map((item) => (
          <div key={item.id} className="relative">
            {selecting ? (
              <button
                type="button"
                role="checkbox"
                aria-checked={selected.has(item.id)}
                aria-label={`Select ${item.applicant.full_name}`}
                onClick={() => toggleSelected(item.id)}
                className={cn(
                  'absolute inset-0 z-10 rounded-[12px] border-2',
                  selected.has(item.id) ? 'border-brand bg-brand/10' : 'border-transparent',
                )}
              />
            ) : null}
            <ApplicationCard item={item} />
          </div>
        ))
      )}

      {cursor ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void fetchPage(filtersRef.current, cursor, true)}
          className="h-11 rounded-lg border border-slate-300 text-sm font-medium text-ink-secondary hover:bg-surface-muted disabled:text-slate-300"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}

      {selecting && selected.size > 0 ? (
        <BulkActionsBar selectedIds={[...selected]} tags={tags} onClear={exitSelection} />
      ) : null}
    </div>
  )
}
