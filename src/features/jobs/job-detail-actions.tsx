'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/ui/button'
import { DropdownMenu, DropdownItem } from '@/ui/dropdown-menu'
import { ConfirmModal } from '@/ui/modal'
import { CopyButton } from '@/ui/copy-button'
import { ShareButton } from '@/ui/share-button'
import { useToast } from '@/ui/toaster'
import { ApiError, mutate } from '@/lib/api-client'
import type { JobRow } from '@/features/jobs/schemas'

export interface MoveTarget {
  organizationId: string | null
  label: string
}

/**
 * Job detail header actions — share primary; overflow: edit / move workspace /
 * close-reopen / delete (docs/06 §4, docs/02 §10.6). `moveTargets` is pre-filtered
 * by the server page (valid destinations only; null hides the item entirely).
 */
export function JobDetailActions({
  job,
  applyUrl,
  moveTargets = null,
}: {
  job: JobRow
  applyUrl: string
  moveTargets?: MoveTarget[] | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function toggleStatus() {
    setBusy(true)
    try {
      const next = job.status === 'closed' ? 'active' : 'closed'
      await mutate(`/api/jobs/${job.id}`, 'PATCH', { status: next })
      toast(next === 'closed' ? 'Job closed' : 'Job reopened ✓', { tone: 'success' })
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the job.', {
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  async function destroy() {
    setBusy(true)
    try {
      await mutate(`/api/jobs/${job.id}`, 'DELETE')
      toast('Job deleted', { tone: 'info' })
      router.push('/dashboard/jobs')
    } catch {
      toast('Could not delete the job.', { tone: 'danger' })
      setBusy(false)
    }
  }

  async function moveTo(target: MoveTarget) {
    setBusy(true)
    try {
      await mutate(`/api/jobs/${job.id}/move`, 'POST', {
        organization_id: target.organizationId,
      })
      toast(`Job moved to ${target.label} ✓`, { tone: 'success' })
      setMoveOpen(false)
      // The job now lives in another workspace — it leaves this scoped view.
      router.push('/dashboard/jobs')
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not move the job.', { tone: 'danger' })
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <CopyButton text={applyUrl} className="flex-1 sm:flex-none" />
      <ShareButton url={applyUrl} title={job.title} />
      <DropdownMenu
        trigger={
          <Button variant="ghost" size="md" aria-label="Job options" disabled={busy}>
            •••
          </Button>
        }
      >
        <DropdownItem onSelect={() => router.push(`/dashboard/jobs/${job.id}/edit`)}>
          Edit
        </DropdownItem>
        {moveTargets && moveTargets.length > 0 ? (
          <DropdownItem onSelect={() => setMoveOpen(true)}>Move to workspace…</DropdownItem>
        ) : null}
        {job.status !== 'draft' ? (
          <DropdownItem onSelect={toggleStatus}>
            {job.status === 'closed' ? 'Reopen job' : 'Close job'}
          </DropdownItem>
        ) : null}
        <DropdownItem className="text-danger" onSelect={() => setConfirmDelete(true)}>
          Delete job
        </DropdownItem>
      </DropdownMenu>

      <ConfirmModal
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this job?"
        description="All its applications and resume references are deleted too. Files already in your Google Drive are kept (docs/07 §7)."
        confirmLabel="Delete job"
        loading={busy}
        onConfirm={destroy}
      />

      {moveOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-ink/40"
            onClick={() => !busy && setMoveOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Move job to another workspace"
            className="relative z-10 flex w-full max-w-sm flex-col gap-3 rounded-[12px] bg-surface p-5 shadow-xl"
          >
            <h3 className="text-lg font-semibold text-ink">Move “{job.title}” to…</h3>
            <p className="text-xs text-ink-secondary">
              Exclusively-linked applicants move with it (docs/11 §6.2).
            </p>
            <div className="flex flex-col gap-1">
              {moveTargets?.map((t) => (
                <button
                  key={t.organizationId ?? 'personal'}
                  disabled={busy}
                  onClick={() => moveTo(t)}
                  className="rounded-lg px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-slate-100 disabled:opacity-50"
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Button variant="ghost" onClick={() => setMoveOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
