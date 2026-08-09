'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { api, mutate, ApiError } from '@/lib/api-client'
import { useToast } from '@/ui/toaster'
import { TagChip } from '@/ui/tag-chip'
import { Button } from '@/ui/button'
import { IconPlus, IconTag } from '@/ui/icons'
import { cn } from '@/lib/utils'
import type { TagRow } from '@/features/applicants/schemas'

const COLOR_CHOICES = [
  '#6366f1',
  '#0ea5e9',
  '#8b5cf6',
  '#f59e0b',
  '#14b8a6',
  '#16a34a',
  '#f87171',
  '#94a3b8',
]

/**
 * TagEditor — docs/02 §7 + docs/05 §4.5: colored chips, inline create (POST /api/tags),
 * replace-set saving (PUT /api/applicants/:id/tags, journaled).
 */
export function TagEditor({
  applicantId,
  initialTags,
}: {
  applicantId: string
  initialTags: TagRow[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [tags, setTags] = useState<TagRow[]>(initialTags)
  const [open, setOpen] = useState(false)
  const [allTags, setAllTags] = useState<TagRow[] | null>(null)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(COLOR_CHOICES[0] ?? '#6366f1')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function openPanel() {
    setOpen(true)
    setError(null)
    if (allTags === null) {
      try {
        setAllTags(await api<TagRow[]>('/api/tags'))
      } catch {
        setError('Could not load tags.')
        setAllTags([])
      }
    }
  }

  async function saveSet(next: TagRow[]) {
    setSaving(true)
    setError(null)
    try {
      const saved = await mutate<TagRow[]>(`/api/applicants/${applicantId}/tags`, 'PUT', {
        tag_ids: next.map((t) => t.id),
      })
      setTags(saved)
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save tags.')
      toast('Could not save tags', { tone: 'danger' })
    } finally {
      setSaving(false)
    }
  }

  function toggle(tag: TagRow) {
    const has = tags.some((t) => t.id === tag.id)
    void saveSet(has ? tags.filter((t) => t.id !== tag.id) : [...tags, tag])
  }

  async function createTag() {
    const name = newName.trim()
    if (!name) return
    setSaving(true)
    setError(null)
    try {
      const tag = await mutate<TagRow>('/api/tags', 'POST', { name, color: newColor })
      setAllTags((prev) => [...(prev ?? []), tag])
      setNewName('')
      await saveSet([...tags, tag])
      toast(`Tag “${tag.name}” created`, { tone: 'success' })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        setError('A tag with that name already exists.')
      } else {
        setError('Could not create the tag.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {tags.length === 0 ? (
          <span className="text-sm text-ink-secondary">No tags yet.</span>
        ) : (
          tags.map((tag) => (
            <TagChip
              key={tag.id}
              tag={tag}
              onRemove={() => void saveSet(tags.filter((t) => t.id !== tag.id))}
            />
          ))
        )}
        {!open ? (
          <button
            type="button"
            onClick={() => void openPanel()}
            className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 text-xs font-medium text-ink-secondary hover:border-brand hover:text-brand"
          >
            <IconPlus className="size-3.5" /> Add tag
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-surface-muted p-3">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
              <IconTag className="size-4" /> Tags
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm font-medium text-ink-secondary hover:text-ink"
            >
              Done
            </button>
          </div>
          {allTags === null ? (
            <p className="text-sm text-ink-secondary">Loading…</p>
          ) : allTags.length === 0 ? (
            <p className="text-sm text-ink-secondary">No tags yet — create your first below.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {allTags.map((tag) => {
                const active = tags.some((t) => t.id === tag.id)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    disabled={saving}
                    aria-pressed={active}
                    onClick={() => toggle(tag)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                      active
                        ? 'border-transparent text-white'
                        : 'border-slate-300 text-ink-secondary',
                    )}
                    style={active ? { backgroundColor: tag.color } : {}}
                  >
                    {tag.name}
                  </button>
                )
              })}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label htmlFor="new-tag-name" className="text-xs font-medium text-ink-secondary">
              New tag
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="new-tag-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={40}
                placeholder="e.g. Re-apply Q3"
                className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 bg-surface px-3 text-sm text-ink focus:border-brand focus:outline-none"
              />
              <div className="flex gap-1" role="radiogroup" aria-label="Tag color">
                {COLOR_CHOICES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={newColor === c}
                    aria-label={`Color ${c}`}
                    onClick={() => setNewColor(c)}
                    className={cn(
                      'size-6 rounded-full border-2',
                      newColor === c ? 'border-ink' : 'border-transparent',
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={saving || !newName.trim()}
                loading={saving && !!newName.trim()}
                onClick={() => void createTag()}
              >
                Create
              </Button>
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
