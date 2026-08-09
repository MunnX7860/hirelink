'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api-client'
import { Card } from '@/ui/card'
import { TagChip } from '@/ui/tag-chip'
import { IconDownload, IconSearch } from '@/ui/icons'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/time'
import type { ApplicantListItem, TagRow } from '@/features/applicants/schemas'

/**
 * People explorer — docs/02 §7 + docs/06 §4 `/dashboard/applicants`.
 * Search (server-side trigram), tag filter, CSV export honoring current filters.
 */
export function ApplicantExplorer({
  initialItems,
  initialCursor,
  tags,
}: {
  initialItems: ApplicantListItem[]
  initialCursor: string | null
  tags: TagRow[]
}) {
  const [q, setQ] = useState('')
  const [tagId, setTagId] = useState('')
  const [items, setItems] = useState(initialItems)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const buildParams = useCallback((c: string | null, query: string, tag: string) => {
    const p = new URLSearchParams()
    if (query.trim()) p.set('q', query.trim())
    if (tag) p.set('tag_id', tag)
    if (c) p.set('cursor', c)
    return p
  }, [])

  const fetchPage = useCallback(
    async (c: string | null, append: boolean, query: string, tag: string) => {
      setLoading(true)
      setError(null)
      try {
        const res = await api<{ data: ApplicantListItem[]; next_cursor: string | null }>(
          `/api/applicants?${buildParams(c, query, tag)}`,
        )
        setItems((prev) => (append ? [...prev, ...res.data] : res.data))
        setCursor(res.next_cursor)
      } catch {
        setError('Could not load people.')
      } finally {
        setLoading(false)
      }
    },
    [buildParams],
  )

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void fetchPage(null, false, q, tagId), 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [q, tagId, fetchPage])

  const exportParams = new URLSearchParams()
  if (q.trim()) exportParams.set('q', q.trim())
  if (tagId) exportParams.set('tag_id', tagId)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-secondary" />
          <label htmlFor="people-search" className="sr-only">
            Search people
          </label>
          <input
            id="people-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or email…"
            className="h-11 w-full rounded-lg border border-slate-300 bg-surface pl-9 pr-3 text-base text-ink focus:border-brand focus:outline-none"
          />
        </div>
        <a
          href={`/api/applicants/export.csv?${exportParams}`}
          aria-label="Export CSV"
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 text-ink-secondary hover:bg-surface-muted"
        >
          <IconDownload className="size-5" />
        </a>
      </div>

      {tags.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Tag filter">
          <button
            type="button"
            aria-pressed={tagId === ''}
            onClick={() => setTagId('')}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold',
              tagId === ''
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-slate-300 text-ink-secondary',
            )}
          >
            All
          </button>
          {tags.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tagId === t.id}
              onClick={() => setTagId(tagId === t.id ? '' : t.id)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold',
                tagId === t.id
                  ? 'border-transparent text-white'
                  : 'border-slate-300 text-ink-secondary',
              )}
              style={tagId === t.id ? { backgroundColor: t.color } : {}}
            >
              {t.name}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
          {error}{' '}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => void fetchPage(null, false, q, tagId)}
          >
            Retry
          </button>
        </div>
      ) : null}

      {items.length === 0 && !loading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">
          No people match — everyone who applies lands here automatically.
        </p>
      ) : (
        items.map((person) => (
          <Link key={person.id} href={`/dashboard/applicants/${person.id}`}>
            <Card className="flex flex-col gap-2 transition-shadow hover:shadow-md active:bg-surface-muted">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-ink">{person.full_name}</p>
                  <p className="truncate text-sm text-ink-secondary">{person.email}</p>
                </div>
                <span className="shrink-0 text-xs text-ink-secondary">
                  {person.last_applied_at ? relativeTime(person.last_applied_at) : ''}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap gap-1">
                  {person.tags.slice(0, 3).map((t) => (
                    <TagChip key={t.id} tag={t} />
                  ))}
                </div>
                <span className="shrink-0 text-xs text-ink-secondary">
                  {person.applications_count} application
                  {person.applications_count === 1 ? '' : 's'}
                </span>
              </div>
            </Card>
          </Link>
        ))
      )}

      {cursor ? (
        <button
          type="button"
          disabled={loading}
          onClick={() => void fetchPage(cursor, true, q, tagId)}
          className="h-11 rounded-lg border border-slate-300 text-sm font-medium text-ink-secondary hover:bg-surface-muted disabled:text-slate-300"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  )
}
