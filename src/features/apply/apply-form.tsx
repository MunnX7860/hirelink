'use client'

import { useMemo, useRef, useState } from 'react'
import { Card } from '@/ui/card'
import { Input } from '@/ui/input'
import { Textarea } from '@/ui/textarea'
import { Button } from '@/ui/button'
import { RESUME_MAX_BYTES, RESUME_MIME_LABELS } from '@/features/applications/constants'
import type { FormConfigValue } from '@/features/jobs/schemas'

/**
 * Public apply form — docs/02 §4, docs/06 §4.
 * Deliberately hand-rolled state (no RHF/zod shipped to this bundle) to stay
 * inside the docs/06 §8 ≤60 KB route-JS budget; client messages mirror the
 * server zod messages (server remains authoritative — docs/05 §4.2).
 */

type Phase =
  | { kind: 'form' }
  | { kind: 'submitting'; progress: number }
  | { kind: 'success'; alreadyApplied: boolean }
  | { kind: 'closed' }

const BYTES_MB = 1_048_576

export function ApplyForm({
  slug,
  jobTitle,
  formConfig,
}: {
  slug: string
  jobTitle: string
  formConfig: FormConfigValue
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const fields = useMemo(
    () => ({
      phone: formConfig.phone ?? 'optional',
      resume: formConfig.resume ?? 'required',
      cover_note: formConfig.cover_note ?? 'hidden',
    }),
    [formConfig],
  )

  function validate(fd: FormData): Record<string, string> {
    const e: Record<string, string> = {}
    const name = String(fd.get('full_name') ?? '').trim()
    const email = String(fd.get('email') ?? '').trim()
    if (name.length < 2) e.full_name = 'Please enter your full name'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'Please enter a valid email address'
    const phone = String(fd.get('phone') ?? '').trim()
    if (fields.phone === 'required' && !phone) e.phone = 'Phone number is required'
    const file = fd.get('resume')
    if (fields.resume === 'required' && (!(file instanceof File) || file.size === 0)) {
      e.resume = 'Resume is required for this position.'
    }
    if (file instanceof File && file.size > 0) {
      if (file.size > RESUME_MAX_BYTES) e.resume = 'Resume must be 10 MB or smaller.'
      else if (!/\.(pdf|doc|docx)$/i.test(file.name))
        e.resume = 'Resume must be a PDF, DOC or DOCX file.'
    }
    return e
  }

  function onFileChange() {
    const f = fileRef.current?.files?.[0]
    setFileName(f ? `${f.name} · ${(f.size / BYTES_MB).toFixed(1)} MB` : null)
    setErrors((prev) => {
      const next = { ...prev }
      delete next.resume
      return next
    })
  }

  function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault()
    const form = ev.currentTarget
    const fd = new FormData(form)
    setFormError(null)

    const clientErrors = validate(fd)
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors)
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }
    setErrors({})

    // XHR (not fetch) for a real upload progress bar — docs/06 §4.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/apply/${slug}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        setPhase({ kind: 'submitting', progress: Math.round((e.loaded / e.total) * 100) })
    }
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText || '{}') as {
          already_applied?: boolean
          error?: { code?: string; message?: string; details?: Record<string, unknown> }
        }
        if (xhr.status === 201) {
          setPhase({ kind: 'success', alreadyApplied: Boolean(body.already_applied) })
          return
        }
        if (body.error?.code === 'JOB_CLOSED') {
          setPhase({ kind: 'closed' })
          return
        }
        if (body.error?.code === 'VALIDATION_ERROR' && body.error.details) {
          const mapped: Record<string, string> = {}
          for (const [field, msgs] of Object.entries(body.error.details)) {
            if (Array.isArray(msgs) && typeof msgs[0] === 'string') mapped[field] = msgs[0]
          }
          setErrors(mapped)
          setFormError(null)
          setPhase({ kind: 'form' })
          return
        }
        setFormError(body.error?.message ?? 'Something went wrong. Please try again.')
      } catch {
        setFormError('Something went wrong. Please try again.')
      }
      setPhase({ kind: 'form' })
    }
    xhr.onerror = () => {
      setFormError('Connection lost — tap Submit to retry (your answers are kept).')
      setPhase({ kind: 'form' })
    }
    setPhase({ kind: 'submitting', progress: 0 })
    xhr.send(fd)
  }

  if (phase.kind === 'success') {
    return (
      <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success/10 text-2xl">
          ✅
        </span>
        <h2 className="text-xl font-semibold text-ink">
          {phase.alreadyApplied ? 'You already applied' : 'Application received'}
        </h2>
        <p className="text-sm text-ink-secondary">
          {phase.alreadyApplied
            ? `Our records show an application from you for ${jobTitle}. No need to apply again.`
            : `Thanks for applying for ${jobTitle}. We’ve emailed you a confirmation.`}
        </p>
      </Card>
    )
  }

  if (phase.kind === 'closed') {
    return (
      <Card className="px-6 py-10 text-center">
        <p className="text-sm text-ink-secondary">
          This position just closed and is no longer accepting applications.
        </p>
      </Card>
    )
  }

  const submitting = phase.kind === 'submitting'

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Input
          label="Full name"
          name="full_name"
          autoComplete="name"
          required
          error={errors.full_name}
          disabled={submitting}
        />
        <Input
          label="Email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          error={errors.email}
          disabled={submitting}
        />
        {fields.phone !== 'hidden' ? (
          <Input
            label={fields.phone === 'required' ? 'Phone' : 'Phone (optional)'}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required={fields.phone === 'required'}
            error={errors.phone}
            disabled={submitting}
          />
        ) : null}
        {fields.cover_note !== 'hidden' ? (
          <Textarea
            label="Cover note (optional)"
            name="cover_note"
            maxLength={4000}
            error={errors.cover_note}
            disabled={submitting}
          />
        ) : null}
        {fields.resume !== 'hidden' ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="resume" className="text-sm font-medium text-ink">
              {fields.resume === 'required' ? 'Resume' : 'Resume (optional)'}{' '}
              <span className="font-normal text-ink-secondary">
                ({Object.values(RESUME_MIME_LABELS).join(', ')}, max 10 MB)
              </span>
            </label>
            <input
              ref={fileRef}
              id="resume"
              name="resume"
              type="file"
              accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={onFileChange}
              aria-invalid={Boolean(errors.resume)}
              disabled={submitting}
              className="w-full rounded-lg border border-dashed border-slate-300 bg-surface px-3 py-3 text-sm text-ink-secondary file:mr-3 file:rounded-md file:border-0 file:bg-brand/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand"
            />
            {fileName ? <p className="text-sm text-ink-secondary">{fileName}</p> : null}
            {errors.resume ? (
              <p aria-live="polite" className="text-sm text-danger">
                {errors.resume}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Honeypot — invisible to humans, must stay empty (docs/05 §4.2) */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="hidden"
        />

        {submitting ? (
          <div className="flex flex-col gap-2" aria-live="polite">
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-brand transition-all"
                style={{ width: `${phase.progress}%` }}
              />
            </div>
            <p className="text-center text-sm text-ink-secondary">Uploading… {phase.progress}%</p>
          </div>
        ) : null}

        {formError ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        ) : null}

        <Button type="submit" size="lg" className="mt-1 w-full" loading={submitting}>
          Submit application
        </Button>
      </form>
    </Card>
  )
}
