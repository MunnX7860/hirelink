'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/ui/button'
import { StatusPill } from '@/ui/status-pill'
import { DropdownMenu, DropdownItem } from '@/ui/dropdown-menu'
import { useToast } from '@/ui/toaster'
import { mutate } from '@/lib/api-client'
import {
  APPLICATION_STATUSES,
  nextPipelineStatus,
  statusBeforeArchive,
  type ApplicationStatusValue,
  type TimelineEventRow,
} from '@/features/applications/schemas'

/**
 * Pipeline stepper — docs/02 §5/§0 + docs/06 §4: bottom action bar, primary action =
 * "Advance" (next sensible status), overflow menu = any status + archive/unarchive
 * (unarchive restores the pre-archive status from the timeline — docs/05 §4.3).
 */
export function PipelineStepper({
  applicationId,
  status,
  timeline,
}: {
  applicationId: string
  status: ApplicationStatusValue
  timeline: Array<Pick<TimelineEventRow, 'type' | 'payload'>>
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [current, setCurrent] = useState(status)

  const update = useMutation({
    mutationFn: (to: ApplicationStatusValue) =>
      mutate<{ status: ApplicationStatusValue }>(`/api/applications/${applicationId}`, 'PATCH', {
        status: to,
      }),
    onSuccess: (data, to) => {
      setCurrent(data.status)
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      toast(`Moved to ${to} ✓`, { tone: 'success' })
      router.refresh()
    },
    onError: () => toast('Could not update the status. Try again.', { tone: 'danger' }),
  })

  const next = nextPipelineStatus(current)

  return (
    <div className="sticky bottom-20 flex items-center gap-2 rounded-[12px] border border-slate-200 bg-surface/95 p-3 shadow-[0_-1px_8px_rgb(15_23_42/0.06)] backdrop-blur lg:bottom-4">
      <div className="flex items-center gap-2 px-1">
        <span className="text-xs text-ink-secondary">Status</span>
        <StatusPill status={current} />
      </div>
      <div className="flex-1" />
      {next ? (
        <Button
          size="md"
          loading={update.isPending}
          onClick={() => update.mutate(next)}
          aria-label={`Advance to ${next}`}
        >
          Advance → {next}
        </Button>
      ) : null}
      <DropdownMenu
        trigger={
          <Button variant="secondary" size="md" aria-label="More status actions">
            •••
          </Button>
        }
      >
        {current === 'archived' ? (
          <DropdownItem onSelect={() => update.mutate(statusBeforeArchive(timeline))}>
            Unarchive (restore previous status)
          </DropdownItem>
        ) : (
          <>
            {APPLICATION_STATUSES.filter((s) => s !== current && s !== 'archived').map((s) => (
              <DropdownItem key={s} onSelect={() => update.mutate(s)}>
                Move to {s}
              </DropdownItem>
            ))}
            <DropdownItem className="text-ink-secondary" onSelect={() => update.mutate('archived')}>
              Archive
            </DropdownItem>
          </>
        )}
      </DropdownMenu>
    </div>
  )
}
