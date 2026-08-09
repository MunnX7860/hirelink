import { z } from 'zod'

/** Application schemas — docs/05 §4.2–4.3 + §5. Shared client/server. */

export const APPLICATION_STATUSES = [
  'new',
  'reviewing',
  'shortlisted',
  'interview',
  'offered',
  'hired',
  'rejected',
  'archived',
] as const
export const ApplicationStatus = z.enum(APPLICATION_STATUSES)
export type ApplicationStatusValue = z.infer<typeof ApplicationStatus>

/** Primary pipeline chain (docs/02 §0) — "Advance" walks this order. */
export const PIPELINE_ORDER: ReadonlyArray<ApplicationStatusValue> = [
  'new',
  'reviewing',
  'shortlisted',
  'interview',
  'offered',
  'hired',
]

export function nextPipelineStatus(current: ApplicationStatusValue): ApplicationStatusValue | null {
  const idx = PIPELINE_ORDER.indexOf(current)
  if (idx === -1 || idx === PIPELINE_ORDER.length - 1) return null
  return PIPELINE_ORDER[idx + 1] ?? null
}

/**
 * Unarchive restore (docs/05 §4.3): the desired status comes from the last
 * `status_changed` event whose `to` was 'archived' — pure for testing.
 */
export function statusBeforeArchive(
  timeline: Array<{ type: string; payload: unknown }>,
  fallback: ApplicationStatusValue = 'reviewing',
): ApplicationStatusValue {
  const archived = timeline.find(
    (e) =>
      e.type === 'status_changed' &&
      (e.payload as { to?: string } | null)?.to === 'archived' &&
      typeof (e.payload as { from?: string } | null)?.from === 'string',
  )
  const from = (archived?.payload as { from?: string } | undefined)?.from
  return ApplicationStatus.safeParse(from).success ? (from as ApplicationStatusValue) : fallback
}

export const ApplyInput = z
  .object({
    full_name: z.string().trim().min(2, 'Please enter your full name').max(200),
    email: z.string().email('Please enter a valid email address').max(320),
    phone: z.string().trim().max(40).optional(),
    cover_note: z.string().max(4000).optional(),
    source: z.string().max(60).default('direct'),
    website: z.literal('').optional(), // honeypot — docs/05 §4.2
  })
  .strict()
export type ApplyInputValue = z.infer<typeof ApplyInput>

export const UpdateApplicationInput = z
  .object({
    status: ApplicationStatus,
  })
  .strict()

const IsoDate = z.string().date('Use an ISO date (YYYY-MM-DD)')

export const ListApplicationsQuery = z.object({
  job_id: z.string().uuid().optional(),
  status: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(ApplicationStatus))
    .optional(),
  q: z.string().max(120).optional(),
  tag_id: z.string().uuid().optional(),
  date_from: IsoDate.optional(), // docs/05 §4.3 + 02 §6: applied_at range filters
  date_to: IsoDate.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type ListApplicationsQueryValue = z.infer<typeof ListApplicationsQuery>

export interface ApplicationRow {
  id: string
  job_id: string
  applicant_id: string
  status: ApplicationStatusValue
  source_meta: Record<string, unknown>
  applied_at: string
  updated_at: string
}

export interface ApplicantRow {
  id: string
  full_name: string
  email: string
  phone: string | null
  source: string
}

export interface ResumeRow {
  id: string
  application_id: string
  storage_file_id: string | null
  original_filename: string
  mime_type: string
  size_bytes: number
  upload_status: 'uploaded' | 'failed'
}

export interface TimelineEventRow {
  id: string
  type: string
  payload: Record<string, unknown>
  actor_id: string | null
  created_at: string
}

/** Resume file rules — docs/05 §5 (magic bytes, ≤10MB). Canonical: ./constants.ts (zod-free). */
export { RESUME_MAX_BYTES, RESUME_MIME_LABELS } from '@/features/applications/constants'
