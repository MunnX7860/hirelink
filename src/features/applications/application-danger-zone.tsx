'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/api-client'
import { useToast } from '@/ui/toaster'
import { Button } from '@/ui/button'
import { ConfirmModal } from '@/ui/modal'

/**
 * Delete application — docs/05 §4.3 DELETE + docs/07 §7: the DB row is removed;
 * resume files REMAIN in the owner's Google Drive (compliance) and the UI says so.
 */
export function ApplicationDangerZone({ applicationId }: { applicationId: string }) {
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function doDelete() {
    setDeleting(true)
    try {
      const res = await mutate<{ ok: true; drive_files_kept: boolean }>(
        `/api/applications/${applicationId}`,
        'DELETE',
      )
      toast(
        res.drive_files_kept
          ? 'Application deleted — resume files stay in your Drive'
          : 'Application deleted',
        { tone: 'success' },
      )
      router.push('/dashboard')
      router.refresh()
    } catch {
      toast('Could not delete the application', { tone: 'danger' })
      setDeleting(false)
      setOpen(false)
    }
  }

  return (
    <div className="rounded-[12px] border border-danger/30 bg-danger/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Delete this application</p>
          <p className="text-xs text-ink-secondary">
            Removes the record and its history. Resume files in your Drive are kept.
          </p>
        </div>
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
          Delete
        </Button>
      </div>
      <ConfirmModal
        open={open}
        onOpenChange={setOpen}
        title="Delete application?"
        description="This removes the application and its timeline from HireLink. Any resume files stay in your Google Drive — delete them there if needed."
        confirmLabel="Delete application"
        loading={deleting}
        onConfirm={() => void doDelete()}
      />
    </div>
  )
}
