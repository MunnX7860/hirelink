'use client'

import { useState } from 'react'
import { Button } from '@/ui/button'
import { Textarea } from '@/ui/textarea'
import { ApiError, mutate } from '@/lib/api-client'

/**
 * JD draft assist in the job form — docs/10 §3: explicit action, human-in-the-loop
 * (the draft lands in an editable field; AI never saves directly). When AI isn't
 * configured the button explains itself (docs/10 §6).
 */
export function JdDraftAssist({
  aiEnabled,
  getTitle,
  getNotes,
  onApply,
}: {
  aiEnabled: boolean
  getTitle: () => string
  getNotes: () => string
  onApply: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    const title = getTitle().trim()
    if (title.length < 3) {
      setError('Add a job title first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const hint = [getNotes().trim(), notes.trim()].filter(Boolean).join('\n')
      const res = await mutate<{ description: string }>(
        '/api/ai/generate/job-description',
        'POST',
        { title, ...(hint ? { notes: hint } : {}) },
      )
      setDraft(res.description)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t draft a description.')
    } finally {
      setBusy(false)
    }
  }

  if (!aiEnabled) {
    return (
      <p className="text-xs text-ink-secondary">
        Tip: add a Gemini key in{' '}
        <a href="/dashboard/settings" className="font-medium text-brand">
          Settings → AI
        </a>{' '}
        to draft descriptions with AI.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {!open ? (
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            ✨ Draft with AI
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-brand/30 bg-brand/5 p-3">
          <Textarea
            label="Rough notes for the AI (optional)"
            rows={2}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. 6-month contract, weekend shifts, training provided"
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" loading={busy} onClick={() => void generate()}>
              Generate draft
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {draft ? (
            <div className="flex flex-col gap-2 rounded-lg bg-surface p-3">
              <Textarea
                label="Draft — edit before using"
                rows={10}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onApply(draft)
                    setOpen(false)
                  }}
                >
                  Use this draft
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  loading={busy}
                  onClick={() => void generate()}
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
