'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, mutate } from '@/lib/api-client'
import { useToast } from '@/ui/toaster'
import { cn } from '@/lib/utils'
import { TagChip } from '@/ui/tag-chip'
import { StatusPill } from '@/ui/status-pill'
import { IconDots } from '@/ui/icons'
import { relativeTime } from '@/lib/time'
import { PIPELINE_ORDER, type ApplicationStatusValue } from '@/features/applications/schemas'
import type { TagRow } from '@/features/applicants/schemas'
import { BulkActionsBar } from '@/features/applications/bulk-actions-bar'

/** Serializable card shape (server page maps ApplicationListItem → this). */
export interface BoardCardData {
  id: string
  status: ApplicationStatusValue
  applicantName: string
  appliedAt: string
  hasResume: boolean
  resumeFailed: boolean
  tags: Pick<TagRow, 'id' | 'name' | 'color'>[]
}

/** Board columns (docs/02 §6): the pipeline chain + rejected; archived lives off-board. */
export const BOARD_COLUMNS: ReadonlyArray<ApplicationStatusValue> = [...PIPELINE_ORDER, 'rejected']

const LONG_PRESS_MS = 500

/**
 * PipelineBoard — docs/02 §6 + docs/06 §4 `/dashboard/pipeline/[jobId]`.
 * Desktop: HTML5 drag & drop. Mobile: long-press (or ⋯) → Move-to sheet.
 * Optimistic via TanStack Query with rollback toast on failure (E6).
 */
export function PipelineBoard({
  jobId,
  initialCards,
  tags,
}: {
  jobId: string
  initialCards: BoardCardData[]
  tags: TagRow[]
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const queryKey = useMemo(() => ['pipeline', jobId] as const, [jobId])

  const { data: cards } = useQuery({
    queryKey,
    queryFn: async () => {
      const status = BOARD_COLUMNS.join(',')
      const res = await api<{ data: Array<Record<string, unknown>> }>(
        `/api/applications?job_id=${encodeURIComponent(jobId)}&status=${status}&limit=100`,
      )
      return res.data.map(mapApiItem)
    },
    initialData: initialCards,
    initialDataUpdatedAt: 0,
    staleTime: 10_000,
  })

  const grouped = useMemo(() => {
    const map = new Map<ApplicationStatusValue, BoardCardData[]>()
    for (const col of BOARD_COLUMNS) map.set(col, [])
    for (const card of cards) {
      const list = map.get(card.status)
      if (list) list.push(card)
    }
    return map
  }, [cards])

  // ── Single-card move with optimistic update + rollback (docs/13 E6) ──────────
  const moveMutation = useMutation({
    mutationFn: ({ id, to }: { id: string; to: ApplicationStatusValue }) =>
      mutate(`/api/applications/${id}`, 'PATCH', { status: to }),
    onMutate: async ({ id, to }) => {
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData<BoardCardData[]>(queryKey)
      queryClient.setQueryData<BoardCardData[]>(queryKey, (items) =>
        (items ?? []).map((c) => (c.id === id ? { ...c, status: to } : c)),
      )
      return { previous }
    },
    onError: (_err, { id }, context) => {
      queryClient.setQueryData(queryKey, context?.previous)
      const card = (context?.previous ?? []).find((c) => c.id === id)
      toast(`Couldn't move ${card?.applicantName ?? 'the card'} — restored`, { tone: 'danger' })
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  function move(id: string, to: ApplicationStatusValue) {
    const card = cards.find((c) => c.id === id)
    if (!card || card.status === to) return
    moveMutation.mutate({ id, to })
  }

  // ── Selection mode (bulk actions — docs/02 §6) ───────────────────────────────
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

  // ── Move-to sheet (mobile long-press + ⋯ menu) ───────────────────────────────
  const [menuCard, setMenuCard] = useState<BoardCardData | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function startLongPress(card: BoardCardData) {
    longPressTimer.current = setTimeout(() => setMenuCard(card), LONG_PRESS_MS)
  }
  function cancelLongPress() {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
    longPressTimer.current = null
  }

  const [dragOverCol, setDragOverCol] = useState<ApplicationStatusValue | null>(null)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs text-ink-secondary">
          {selecting
            ? 'Tap cards to select, then act below.'
            : 'Drag cards (desktop) or long-press (mobile) to move.'}
        </p>
        <button
          type="button"
          onClick={() => (selecting ? exitSelection() : setSelecting(true))}
          className="text-sm font-medium text-brand"
        >
          {selecting ? 'Done' : 'Select'}
        </button>
      </div>

      <div
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4"
        data-testid="pipeline-board"
      >
        {BOARD_COLUMNS.map((col) => {
          const colCards = grouped.get(col) ?? []
          return (
            <section
              key={col}
              aria-label={`${col} column`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverCol(col)
              }}
              onDragLeave={() => setDragOverCol((c) => (c === col ? null : c))}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverCol(null)
                const id = e.dataTransfer.getData('text/plain')
                if (id) move(id, col)
              }}
              className={cn(
                'flex w-40 shrink-0 snap-start flex-col gap-2 rounded-xl bg-surface-muted p-2 sm:w-44',
                dragOverCol === col && 'ring-2 ring-brand',
              )}
            >
              <header className="flex items-center justify-between px-1 pt-1">
                <StatusPill status={col} />
                <span className="text-xs font-semibold text-ink-secondary">{colCards.length}</span>
              </header>
              {colCards.map((card) => (
                <article
                  key={card.id}
                  draggable={!selecting}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', card.id)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onTouchStart={() => !selecting && startLongPress(card)}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  className={cn(
                    'relative flex flex-col gap-1 rounded-lg border bg-surface p-2.5 shadow-sm',
                    selected.has(card.id) ? 'border-brand ring-1 ring-brand' : 'border-slate-200',
                    !selecting && 'cursor-grab active:cursor-grabbing',
                  )}
                  data-testid={`pipeline-card-${card.id}`}
                >
                  <div className="flex items-start justify-between gap-1">
                    {selecting ? (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={selected.has(card.id)}
                        aria-label={`Select ${card.applicantName}`}
                        onClick={() => toggleSelected(card.id)}
                        className="absolute inset-0 z-10 rounded-lg"
                      />
                    ) : null}
                    <Link
                      href={`/dashboard/applications/${card.id}`}
                      className="min-w-0 flex-1 truncate text-sm font-semibold text-ink hover:text-brand"
                    >
                      {card.applicantName}
                    </Link>
                    {!selecting ? (
                      <button
                        type="button"
                        aria-label={`Move ${card.applicantName}`}
                        onClick={() => setMenuCard(card)}
                        className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-slate-100"
                      >
                        <IconDots className="size-4" />
                      </button>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-ink-secondary">{relativeTime(card.appliedAt)}</p>
                  {card.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {card.tags.slice(0, 3).map((t) => (
                        <TagChip key={t.id} tag={t} />
                      ))}
                    </div>
                  ) : null}
                  {card.resumeFailed ? (
                    <p className="text-[11px] font-medium text-warning">Resume failed</p>
                  ) : card.hasResume ? (
                    <p className="text-[11px] text-ink-secondary">📄 Resume</p>
                  ) : null}
                </article>
              ))}
              {colCards.length === 0 ? (
                <p className="px-1 py-3 text-center text-[11px] text-slate-400">Empty</p>
              ) : null}
            </section>
          )
        })}
      </div>

      {/* Move-to sheet (docs/06 §3 Sheet/Drawer — bottom on mobile) */}
      <Dialog.Root open={menuCard !== null} onOpenChange={(open) => !open && setMenuCard(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
          <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface p-4 pb-8 shadow-xl sm:left-1/2 sm:bottom-auto sm:top-1/2 sm:w-80 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:pb-4">
            <Dialog.Title className="text-base font-semibold text-ink">
              Move {menuCard?.applicantName}
            </Dialog.Title>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {BOARD_COLUMNS.filter((s) => s !== menuCard?.status).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    if (menuCard) move(menuCard.id, s)
                    setMenuCard(null)
                  }}
                  className="flex h-11 items-center justify-center rounded-lg border border-slate-200 text-sm font-medium text-ink hover:border-brand hover:text-brand"
                >
                  {s}
                </button>
              ))}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {selecting && selected.size > 0 ? (
        <BulkActionsBar selectedIds={[...selected]} tags={tags} onClear={exitSelection} />
      ) : null}
    </div>
  )
}

function mapApiItem(row: Record<string, unknown>): BoardCardData {
  const applicant = row.applicant as { full_name?: string } | undefined
  return {
    id: row.id as string,
    status: row.status as ApplicationStatusValue,
    applicantName: applicant?.full_name ?? 'Unknown',
    appliedAt: row.applied_at as string,
    hasResume: Boolean(row.has_resume),
    resumeFailed: Boolean(row.resume_failed),
    tags: (row.tags as BoardCardData['tags']) ?? [],
  }
}
