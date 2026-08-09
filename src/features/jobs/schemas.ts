import { z } from 'zod'

/** Job schemas — docs/05 §4.1/§5 (normative shapes). Shared client/server. */

export const JOB_STATUSES = ['draft', 'active', 'closed'] as const
export const JobStatus = z.enum(JOB_STATUSES)
export type JobStatusValue = z.infer<typeof JobStatus>

export const FormFieldRule = z.enum(['required', 'optional', 'hidden'])
export type FormFieldRuleValue = z.infer<typeof FormFieldRule>

export const FormConfig = z
  .object({
    phone: FormFieldRule.default('optional'),
    resume: FormFieldRule.default('required'),
    cover_note: FormFieldRule.default('hidden'),
  })
  .strict()
export type FormConfigValue = z.infer<typeof FormConfig>

export const CreateJobInput = z
  .object({
    title: z.string().trim().min(3, 'Title needs at least 3 characters').max(120),
    description: z.string().max(5000).default(''),
    form_config: FormConfig.default({
      phone: 'optional',
      resume: 'required',
      cover_note: 'hidden',
    }),
  })
  .strict()
export type CreateJobInputValue = z.infer<typeof CreateJobInput>

export const UpdateJobInput = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    description: z.string().max(5000).optional(),
    form_config: FormConfig.optional(),
    status: JobStatus.optional(),
  })
  .strict()

/** docs/05 §4.1 — allowed status transitions: draft→active→closed, active↔closed. */
const ALLOWED_TRANSITIONS: Record<JobStatusValue, ReadonlySet<JobStatusValue>> = {
  draft: new Set(['active', 'closed']),
  active: new Set(['closed']),
  closed: new Set(['active']),
}

export function canTransitionJob(from: JobStatusValue, to: JobStatusValue): boolean {
  if (from === to) return true
  return ALLOWED_TRANSITIONS[from].has(to)
}

/** Row shape mirrored from docs/04 §3.3 (casts at the DB boundary). */
export interface JobRow {
  id: string
  owner_id: string
  organization_id: string | null
  title: string
  description: string
  slug: string
  status: JobStatusValue
  form_config: FormConfigValue
  drive_folder_id: string | null
  created_at: string
  updated_at: string
}

/** Public apply-page payload — docs/05 §4.1 GET /api/jobs/:slug/public (no IDs, no owner info). */
export interface PublicJob {
  title: string
  description: string
  status: JobStatusValue
  form_config: FormConfigValue
}
