'use client'

import { useMemo, useRef, useState } from 'react'
import { Card } from '@/ui/card'
import { Input } from '@/ui/input'
import { Select } from '@/ui/select'
import { Textarea } from '@/ui/textarea'
import { Button } from '@/ui/button'
import { RESUME_MAX_BYTES, RESUME_MIME_LABELS } from '@/features/applications/constants'
import type { FormConfigValue } from '@/features/jobs/schemas'
import {
  EDUCATION_LEVELS,
  EDUCATION_LABELS,
  type PublicQuestionValue,
} from '@/features/screening/schemas'

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
  questions = [],
  primaryColor = null,
}: {
  slug: string
  jobTitle: string
  formConfig: FormConfigValue
  /** Phase 5 (17 §3.3): sanitized question schema — never carries rules. */
  questions?: PublicQuestionValue[]
  /** docs/11 §9: org brand accent (pro/team custom branding only) — accents the primary CTA. */
  primaryColor?: string | null
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'form' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [answers, setAnswers] = useState<Record<string, string | number | boolean | string[]>>({})

  function setAnswer(questionId: string, value: string | number | boolean | string[]) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }))
    setErrors((prev) => {
      const next = { ...prev }
      delete next[`answers.${questionId}`]
      return next
    })
  }

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
    // Required questionnaire answers (mirrors server validateAnswers — 17 §5).
    for (const q of questions) {
      if (!q.required) continue
      const value = answers[q.id]
      const empty =
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'string' && value.trim() === '')
      if (empty) e[`answers.${q.id}`] = 'This question needs an answer.'
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

  // Drag-and-drop resume upload — docs/06 §3 FileDrop primitive: native picker on
  // mobile (below), drag-drop layered on top for >=md pointer/mouse devices only
  // (touch devices never fire HTML5 drag events, so no extra gating is needed).
  const [dragActive, setDragActive] = useState(false)

  function onDragOver(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault()
    setDragActive(true)
  }

  function onDragLeave() {
    setDragActive(false)
  }

  function onDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault()
    setDragActive(false)
    const file = ev.dataTransfer.files?.[0]
    if (!file || !fileRef.current) return
    const dt = new DataTransfer()
    dt.items.add(file)
    fileRef.current.files = dt.files
    onFileChange()
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
    if (questions.length > 0) fd.set('answers', JSON.stringify(answers))

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
      <form
        action={`/api/apply/${slug}`}
        method="post"
        encType="multipart/form-data"
        onSubmit={onSubmit}
        noValidate
        className="flex flex-col gap-4"
      >
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
        {questions.map((q) => (
          <QuestionField
            key={q.id}
            question={q}
            value={answers[q.id]}
            onChange={(v) => setAnswer(q.id, v)}
            error={errors[`answers.${q.id}`]}
            disabled={submitting}
          />
        ))}
        {fields.resume !== 'hidden' ? (
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`flex flex-col gap-1.5 rounded-lg md:border-2 md:border-dashed md:p-2 md:transition-colors ${
              dragActive ? 'md:border-brand md:bg-brand/5' : 'md:border-transparent'
            }`}
          >
            <label htmlFor="resume" className="text-sm font-medium text-ink">
              {fields.resume === 'required' ? 'Resume' : 'Resume (optional)'}{' '}
              <span className="font-normal text-ink-secondary">
                ({Object.values(RESUME_MIME_LABELS).join(', ')}, max 10 MB)
                <span className="hidden md:inline"> · drag and drop or click to browse</span>
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

        <Button
          type="submit"
          size="lg"
          className="mt-1 w-full"
          loading={submitting}
          style={primaryColor ? { backgroundColor: primaryColor } : undefined}
        >
          Submit application
        </Button>
      </form>
    </Card>
  )
}

// ── Screening questionnaire fields (docs/17 §3.3 — native inputs only) ────────

type AnswerValue = string | number | boolean | string[] | undefined

function QuestionField({
  question,
  value,
  onChange,
  error,
  disabled,
}: {
  question: PublicQuestionValue
  value: AnswerValue
  onChange: (value: string | number | boolean | string[]) => void
  error: string | undefined
  disabled: boolean
}) {
  // Same idiom as the rest of the apply form: required = bare label, optional = suffix.
  const labelText = question.required ? question.label : `${question.label} (optional)`

  const errorEl = error ? (
    <p aria-live="polite" className="mt-1 text-sm text-danger">
      {error}
    </p>
  ) : null

  const optionBtn = (checked: boolean) =>
    `rounded-lg border px-3 py-2 text-sm ${
      checked ? 'border-brand bg-brand/10 font-medium text-brand' : 'border-slate-300 text-ink'
    }`

  switch (question.type) {
    case 'yes_no':
    case 'relocate':
      return (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-ink">{labelText}</legend>
          <div className="flex gap-2">
            {([true, false] as const).map((option) => (
              <label key={String(option)} className="flex-1">
                <input
                  type="radio"
                  name={`q_${question.id}`}
                  className="sr-only"
                  checked={value === option}
                  onChange={() => onChange(option)}
                  disabled={disabled}
                />
                <span className={`block text-center ${optionBtn(value === option)}`}>
                  {option ? 'Yes' : 'No'}
                </span>
              </label>
            ))}
          </div>
          {errorEl}
        </fieldset>
      )

    case 'single_choice':
      return (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-ink">{labelText}</legend>
          <div className="flex flex-col gap-2">
            {(question.options ?? []).map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name={`q_${question.id}`}
                  checked={value === option}
                  onChange={() => onChange(option)}
                  disabled={disabled}
                  className="size-4 accent-brand"
                />
                {option}
              </label>
            ))}
          </div>
          {errorEl}
        </fieldset>
      )

    case 'multiple_choice':
      return (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-ink">{labelText}</legend>
          <div className="flex flex-col gap-2">
            {(question.options ?? []).map((option) => {
              const current = Array.isArray(value) ? value : []
              const checked = current.includes(option)
              return (
                <label key={option} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    aria-invalid={Boolean(error)}
                    className="size-4 accent-brand"
                    onChange={() =>
                      onChange(checked ? current.filter((v) => v !== option) : [...current, option])
                    }
                  />
                  {option}
                </label>
              )
            })}
          </div>
          {errorEl}
        </fieldset>
      )

    case 'dropdown':
      return (
        <div>
          <Select
            id={`q_${question.id}`}
            label={labelText}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            aria-invalid={Boolean(error)}
          >
            <option value="">Select…</option>
            {(question.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          {errorEl}
        </div>
      )

    case 'education':
      return (
        <div>
          <Select
            id={`q_${question.id}`}
            label={labelText}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            aria-invalid={Boolean(error)}
          >
            <option value="">Select…</option>
            {EDUCATION_LEVELS.map((level) => (
              <option key={level} value={level}>
                {EDUCATION_LABELS[level]}
              </option>
            ))}
          </Select>
          {errorEl}
        </div>
      )

    case 'number':
    case 'experience_years':
      return (
        <Input
          label={labelText}
          id={`q_${question.id}`}
          type="number"
          inputMode="decimal"
          min={0}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value)}
          error={error}
          disabled={disabled}
        />
      )

    case 'current_ctc':
    case 'expected_ctc':
      return (
        <Input
          label={labelText}
          id={`q_${question.id}`}
          type="number"
          inputMode="numeric"
          min={0}
          placeholder="Per year, digits only"
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value)}
          error={error}
          disabled={disabled}
        />
      )

    case 'text':
    case 'location':
      return (
        <Input
          label={labelText}
          id={`q_${question.id}`}
          type="text"
          maxLength={500}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          error={error}
          disabled={disabled}
        />
      )
  }
}
