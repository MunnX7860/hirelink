'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Switch } from '@/ui/switch'
import { Button } from '@/ui/button'
import { ConfirmModal } from '@/ui/modal'
import { useToast } from '@/ui/toaster'
import { ApiError, mutate } from '@/lib/api-client'
import { createClient } from '@/lib/supabase/client'

/** Notification toggles — docs/02 §9 + PATCH /api/users/me. */
export function ProfileSettings({
  notifyTelegram,
  notifyApplicantEmail,
}: {
  notifyTelegram: boolean
  notifyApplicantEmail: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [telegram, setTelegram] = useState(notifyTelegram)
  const [email, setEmail] = useState(notifyApplicantEmail)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function save(patch: { notify_telegram?: boolean; notify_applicant_email?: boolean }) {
    setSaving(true)
    try {
      await mutate('/api/users/me', 'PATCH', patch)
      toast('Preferences saved ✓', { tone: 'success' })
    } catch {
      toast('Could not save. Try again.', { tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  async function deleteAccount() {
    if (deleting) return
    setDeleting(true)
    try {
      await mutate('/api/users/me', 'DELETE')
      await createClient().auth.signOut()
      toast('Your account has been deleted.', { tone: 'info' })
      router.push('/login')
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete your account. Try again.', {
        tone: 'danger',
      })
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col">
      <ToggleRow
        label="Telegram alerts"
        hint="Ping me for every new applicant"
        checked={telegram}
        disabled={saving}
        onCheckedChange={(v) => {
          setTelegram(v)
          void save({ notify_telegram: v })
        }}
      />
      <ToggleRow
        label="Applicant confirmation emails"
        hint="Email applicants when their application is received"
        checked={email}
        disabled={saving}
        onCheckedChange={(v) => {
          setEmail(v)
          void save({ notify_applicant_email: v })
        }}
      />

      {/* Data & Danger zone — docs/02 §9 */}
      <div className="mt-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-semibold text-ink">Your data</h3>
        <p className="mt-1 text-xs text-ink-secondary">
          Download a copy of everything in your personal workspace (jobs, candidates, applications,
          notes, tags). Your resume files stay in your own Google Drive and aren&apos;t included.
        </p>
        <a
          href="/api/users/me/export"
          className="mt-2 inline-flex h-9 items-center justify-center rounded-lg border border-slate-300 bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-muted"
        >
          Export my data
        </a>
      </div>

      <div className="mt-4 rounded-lg border border-danger/30 p-3">
        <h3 className="text-sm font-semibold text-danger">Danger zone</h3>
        <p className="mt-1 text-xs text-ink-secondary">
          Deleting your account removes your profile, personal jobs, candidates, notes, tags, and
          connected integrations — permanently. Your Google Drive files are never touched. If you
          own an organization or have jobs/candidates inside a shared workspace, transfer or
          reassign them first.
        </p>
        <Button variant="danger" size="sm" className="mt-2" onClick={() => setConfirmDelete(true)}>
          Delete my account
        </Button>
        <ConfirmModal
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title="Delete your account?"
          description="This permanently removes your profile and everything in your personal workspace. This cannot be undone."
          confirmLabel="Delete my account"
          loading={deleting}
          onConfirm={deleteAccount}
        />
      </div>
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 py-3">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-xs text-ink-secondary">{hint}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  )
}
