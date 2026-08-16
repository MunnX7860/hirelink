'use client'

import { useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Card } from '@/ui/card'
import { Input } from '@/ui/input'
import { Textarea } from '@/ui/textarea'
import { JdDraftAssist } from '@/features/ai/jd-draft-assist'
import { Switch } from '@/ui/switch'
import { Button } from '@/ui/button'
import { Banner } from '@/ui/banner'
import { CopyButton } from '@/ui/copy-button'
import { ShareButton } from '@/ui/share-button'
import { useToast } from '@/ui/toaster'
import { api, ApiError } from '@/lib/api-client'
import { CreateJobInput, type JobRow } from '@/features/jobs/schemas'
import { QuestionnaireBuilder } from '@/features/screening/questionnaire-builder'
import type { ReusableQuestionnaire } from '@/features/screening/server'

/**
 * Job form — docs/02 §2 (minimal fields, sane defaults) + success state with the
 * hiring link (Copy + native share — docs/02 §3, docs/06 §4).
 * Used for both create (POST) and edit (PATCH).
 */

type FormValues = z.input<typeof CreateJobInput>

export function JobForm({
  mode,
  job,
  driveConnected,
  aiEnabled,
  reusable = [],
}: {
  mode: 'create' | 'edit'
  job?: JobRow | undefined
  driveConnected: boolean
  aiEnabled: boolean
  /** Create mode only: other jobs whose questionnaires can be copied in step 2. */
  reusable?: ReusableQuestionnaire[]
}) {
  const toast = useToast()
  const [created, setCreated] = useState<{ id: string; title: string; url: string } | null>(null)
  // Screening used to live behind "create the job, then go find Edit" — a detour
  // most recruiters never took, so jobs shipped with no questionnaire at all.
  // Step 2 puts it directly in the create path, still skippable.
  const [step, setStep] = useState<'screening' | 'done'>('screening')

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateJobInput),
    defaultValues: {
      title: job?.title ?? '',
      description: job?.description ?? '',
      form_config: job?.form_config ?? {
        phone: 'optional',
        resume: 'required',
        cover_note: 'hidden',
      },
    },
  })

  const resumeRule = watch('form_config.resume')

  async function submit(values: FormValues) {
    try {
      if (mode === 'create') {
        const createdJob = await api<JobRow & { apply_url: string }>('/api/jobs', {
          method: 'POST',
          body: values,
        })
        setCreated({ id: createdJob.id, title: createdJob.title, url: createdJob.apply_url })
      } else if (job) {
        await api<JobRow>(`/api/jobs/${job.id}`, { method: 'PATCH', body: values })
        toast('Job updated ✓', { tone: 'success' })
        window.location.assign(`/dashboard/jobs/${job.id}`)
      }
    } catch (err) {
      if (err instanceof ApiError) toast(err.message, { tone: 'danger' })
      else toast('Something went wrong. Please try again.', { tone: 'danger' })
    }
  }

  // Step 2 — screening. The job already exists at this point, so nothing here
  // can lose work: skipping just moves on, and the builder saves independently.
  if (created && step === 'screening') {
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
            Step 2 of 2
          </p>
          <h2 className="text-lg font-semibold text-ink">Want to sort applicants automatically?</h2>
          <p className="text-sm text-ink-secondary">
            “{created.title}” is created. Add a few questions and candidates get marked Qualified or
            Not qualified the moment they apply — or skip and do it later.
          </p>
        </Card>

        <QuestionnaireBuilder
          jobId={created.id}
          initialQuestions={[]}
          reusable={reusable}
          showRecompute={false}
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => setStep('done')}>
            Skip for now
          </Button>
          <Button onClick={() => setStep('done')}>Done — show my link</Button>
        </div>
      </div>
    )
  }

  if (created) {
    return (
      <Card className="flex flex-col items-center gap-4 px-6 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success/10 text-2xl">
          🎉
        </span>
        <div>
          <h2 className="text-xl font-semibold text-ink">Your hiring link is ready</h2>
          <p className="mt-1 text-sm text-ink-secondary">Share it anywhere your audience is.</p>
        </div>
        <code className="w-full break-all rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink">
          {created.url}
        </code>
        <div className="flex w-full flex-col gap-2 sm:flex-row">
          <CopyButton text={created.url} className="flex-1" />
          <ShareButton url={created.url} title={created.title} />
        </div>
        {!driveConnected ? (
          <Banner tone="warning" title="Connect Google Drive">
            Resumes can’t be stored until Drive is connected — applicants can still apply meanwhile.
          </Banner>
        ) : null}
      </Card>
    )
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="flex flex-col gap-4">
      {mode === 'create' ? (
        <p className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
          Step 1 of 2 — the basics
        </p>
      ) : null}

      {!driveConnected && resumeRule !== 'hidden' ? (
        <Banner tone="warning" title="Google Drive not connected">
          Resumes can’t be stored until you connect Drive in Settings. You can still create the job.
        </Banner>
      ) : null}

      <Card className="flex flex-col gap-4">
        <Input
          label="Job title"
          placeholder="e.g. Barista, Store Manager"
          error={errors.title?.message}
          {...register('title')}
        />
        <Textarea
          label="Description (optional)"
          placeholder="What is the role? What should applicants know?"
          error={errors.description?.message}
          {...register('description')}
        />
        {/* docs/10 §3 — explicit action, human-in-the-loop: the draft always lands
            in this editable field; AI never saves directly. */}
        <JdDraftAssist
          aiEnabled={aiEnabled}
          getTitle={() => getValues('title') ?? ''}
          getNotes={() => getValues('description') ?? ''}
          onApply={(text) => setValue('description', text, { shouldDirty: true })}
        />
      </Card>

      <Card className="flex flex-col gap-1">
        <h2 className="mb-2 text-base font-semibold text-ink">Application form fields</h2>
        <FieldRow label="Full name + Email" value="Always asked" fixed />
        <Controller
          control={control}
          name="form_config.resume"
          render={({ field }) => (
            <FieldRow
              label="Resume"
              value={
                field.value === 'hidden'
                  ? 'Hidden'
                  : field.value === 'required'
                    ? 'Required'
                    : 'Optional'
              }
              toggle={{
                checked: field.value !== 'hidden',
                onChange: (on) => field.onChange(on ? 'required' : 'hidden'),
              }}
              triState={
                field.value !== 'hidden'
                  ? {
                      value: field.value === 'required' ? 'required' : 'optional',
                      onChange: (v: 'required' | 'optional') => field.onChange(v),
                    }
                  : undefined
              }
            />
          )}
        />
        <Controller
          control={control}
          name="form_config.phone"
          render={({ field }) => (
            <FieldRow
              label="Phone"
              value={
                field.value === 'hidden'
                  ? 'Hidden'
                  : field.value === 'required'
                    ? 'Required'
                    : 'Optional'
              }
              toggle={{
                checked: field.value !== 'hidden',
                onChange: (on) => field.onChange(on ? 'optional' : 'hidden'),
              }}
              triState={
                field.value !== 'hidden'
                  ? {
                      value: field.value === 'required' ? 'required' : 'optional',
                      onChange: (v: 'required' | 'optional') => field.onChange(v),
                    }
                  : undefined
              }
            />
          )}
        />
        <Controller
          control={control}
          name="form_config.cover_note"
          render={({ field }) => (
            <FieldRow
              label="Cover note"
              value={field.value === 'hidden' ? 'Hidden' : 'Optional'}
              toggle={{
                checked: field.value !== 'hidden',
                onChange: (on) => field.onChange(on ? 'optional' : 'hidden'),
              }}
            />
          )}
        />
      </Card>

      <Button
        type="submit"
        size="lg"
        loading={isSubmitting}
        className="w-full sm:w-auto sm:self-start"
      >
        {mode === 'create' ? 'Create job & get link' : 'Save changes'}
      </Button>
    </form>
  )
}

function FieldRow({
  label,
  value,
  fixed = false,
  toggle,
  triState,
}: {
  label: string
  value: string
  fixed?: boolean | undefined
  toggle?: { checked: boolean; onChange: (on: boolean) => void } | undefined
  triState?:
    | {
        value: 'required' | 'optional'
        onChange: (v: 'required' | 'optional') => void
      }
    | undefined
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-3 last:border-0">
      <div>
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-xs text-ink-secondary">{value}</p>
      </div>
      <div className="flex items-center gap-2">
        {triState ? (
          <button
            type="button"
            onClick={() =>
              triState.onChange(triState.value === 'required' ? 'optional' : 'required')
            }
            className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-ink-secondary"
            aria-label={`Toggle ${label} required/optional`}
          >
            {triState.value === 'required' ? 'Required' : 'Optional'} ⇄
          </button>
        ) : null}
        {fixed ? (
          <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-ink-secondary">
            Fixed
          </span>
        ) : toggle ? (
          <Switch
            checked={toggle.checked}
            onCheckedChange={toggle.onChange}
            aria-label={`${label} visibility`}
          />
        ) : null}
      </div>
    </div>
  )
}
