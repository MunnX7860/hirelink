'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/api-client'

/** Inline phone editor — docs/05 §4.4 PATCH /api/applicants/:id (null clears). */
export function PhoneEditor({ applicantId, phone }: { applicantId: string; phone: string | null }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(phone ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await mutate(`/api/applicants/${applicantId}`, 'PATCH', { phone: value.trim() || null })
      setEditing(false)
      router.refresh()
    } catch {
      setError('Could not save.')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return phone ? (
      <a href={`tel:${phone}`} className="font-medium text-brand">
        {phone}
      </a>
    ) : (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-sm font-medium text-brand"
      >
        Add phone
      </button>
    )
  }

  return (
    <span className="flex items-center gap-2">
      <label htmlFor="phone-edit" className="sr-only">
        Phone
      </label>
      <input
        id="phone-edit"
        type="tel"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={40}
        className="h-9 w-40 rounded-lg border border-slate-300 bg-surface px-2 text-sm text-ink focus:border-brand focus:outline-none"
      />
      <button
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className="text-sm font-semibold text-brand disabled:text-slate-400"
      >
        Save
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setEditing(false)
          setValue(phone ?? '')
        }}
        className="text-sm text-ink-secondary"
      >
        Cancel
      </button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  )
}
