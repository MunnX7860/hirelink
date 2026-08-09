'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { mutate, ApiError } from '@/lib/api-client'
import { useToast } from '@/ui/toaster'
import { Button } from '@/ui/button'
import { APPLICATION_STATUSES, type ApplicationStatusValue } from '@/features/applications/schemas'
import type { TagRow } from '@/features/applicants/schemas'

interface BulkResult {
  updated: number
  failed_ids: string[]
}

/**
 * BulkActionsBar — docs/02 §6: select N → change status / add tag / archive,
 * single PATCH /api/applications batch call (docs/05 §4.3; ≤100 ids).
 * Fixed to the thumb zone; one row on mobile.
 */
export function BulkActionsBar({
  selectedIds,
  tags,
  onClear,
}: {
  selectedIds: string[]
  tags: TagRow[]
  onClear: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [status, setStatus] = useState<ApplicationStatusValue>('reviewing')
  const [tagId, setTagId] = useState<string>('')
  const [busy, setBusy] = useState(false)

  async function run(action: 'set_status' | 'archive' | 'add_tag', value: string) {
    if (busy || selectedIds.length === 0) return
    setBusy(true)
    try {
      const result = await mutate<BulkResult>('/api/applications', 'PATCH', {
        ids: selectedIds.slice(0, 100),
        action,
        value,
      })
      const failed = result.failed_ids.length
      if (failed === 0) {
        toast(`${result.updated} application${result.updated === 1 ? '' : 's'} updated`, {
          tone: 'success',
        })
      } else {
        toast(`${result.updated} updated, ${failed} failed — retry those`, { tone: 'danger' })
      }
      await queryClient.invalidateQueries() // pipeline + lists refetch
      onClear()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Bulk update failed', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-16 z-20 border-t border-slate-200 bg-surface p-3 shadow-lg lg:bottom-0">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{selectedIds.length} selected</span>
        <div className="flex items-center gap-1">
          <select
            aria-label="Set status to"
            value={status}
            onChange={(e) => setStatus(e.target.value as ApplicationStatusValue)}
            className="h-9 rounded-lg border border-slate-300 bg-surface px-2 text-sm text-ink"
          >
            {APPLICATION_STATUSES.filter((s) => s !== 'archived').map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void run('set_status', status)}
          >
            Set status
          </Button>
        </div>
        {tags.length > 0 ? (
          <div className="flex items-center gap-1">
            <select
              aria-label="Tag to add"
              value={tagId}
              onChange={(e) => setTagId(e.target.value)}
              className="h-9 rounded-lg border border-slate-300 bg-surface px-2 text-sm text-ink"
            >
              <option value="">Choose tag…</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !tagId}
              onClick={() => void run('add_tag', tagId)}
            >
              Add tag
            </Button>
          </div>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void run('archive', '')}
        >
          Archive
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClear}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
