'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { mutate } from '@/lib/api-client'
import { useToast } from '@/ui/toaster'
import { Button } from '@/ui/button'
import { IconTrash } from '@/ui/icons'
import { relativeTime } from '@/lib/time'
import type { NoteRow } from '@/features/applicants/schemas'

/**
 * Notes composer + list — docs/02 §7, docs/05 §4.5 (note_added timeline journal
 * happens server-side; deletion is immediate with an Undo toast… not offered in
 * Phase 2, but the confirm-free delete only removes the note copy, not history).
 */
export function NotesSection({
  applicantId,
  applicationId,
  notes,
}: {
  applicantId: string
  applicationId?: string | null | undefined
  notes: NoteRow[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function addNote() {
    const text = body.trim()
    if (!text) return
    setSaving(true)
    setError(null)
    try {
      await mutate('/api/notes', 'POST', {
        applicant_id: applicantId,
        ...(applicationId ? { application_id: applicationId } : {}),
        body: text,
      })
      setBody('')
      toast('Note added', { tone: 'success' })
      router.refresh()
    } catch {
      setError('Could not save the note. Your text is preserved above.')
    } finally {
      setSaving(false)
    }
  }

  async function removeNote(id: string) {
    setDeletingId(id)
    try {
      await mutate(`/api/notes/${id}`, 'DELETE')
      toast('Note deleted', { tone: 'info' })
      router.refresh()
    } catch {
      toast('Could not delete the note', { tone: 'danger' })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <label htmlFor="note-body" className="text-xs font-medium text-ink-secondary">
          Add a note
        </label>
        <textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={5000}
          placeholder="Interview feedback, salary expectations, where you met…"
          className="w-full rounded-lg border border-slate-300 bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none"
        />
        <Button
          type="button"
          variant="secondary"
          className="self-end"
          disabled={!body.trim() || saving}
          loading={saving}
          onClick={() => void addNote()}
        >
          Save note
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>

      {notes.length === 0 ? (
        <p className="py-2 text-sm text-ink-secondary">No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li key={note.id} className="rounded-lg bg-surface-muted p-3">
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap text-sm leading-6 text-ink">{note.body}</p>
                <button
                  type="button"
                  aria-label="Delete note"
                  disabled={deletingId === note.id}
                  onClick={() => void removeNote(note.id)}
                  className="shrink-0 rounded p-1 text-ink-secondary hover:text-danger"
                >
                  <IconTrash className="size-4" />
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-secondary">{relativeTime(note.created_at)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
