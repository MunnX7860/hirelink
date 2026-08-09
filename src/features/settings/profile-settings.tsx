'use client'

import { useState } from 'react'
import { Switch } from '@/ui/switch'
import { useToast } from '@/ui/toaster'
import { mutate } from '@/lib/api-client'

/** Notification toggles — docs/02 §9 + PATCH /api/users/me. */
export function ProfileSettings({
  notifyTelegram,
  notifyApplicantEmail,
}: {
  notifyTelegram: boolean
  notifyApplicantEmail: boolean
}) {
  const toast = useToast()
  const [telegram, setTelegram] = useState(notifyTelegram)
  const [email, setEmail] = useState(notifyApplicantEmail)
  const [saving, setSaving] = useState(false)

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
