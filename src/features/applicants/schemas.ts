import { z } from 'zod'
import { TIMELINE_EVENT_TYPES } from '@/features/applications/constants'
import type { TimelineEventRow } from '@/features/applications/schemas'

/** Talent-pool schemas — docs/05 §4.4–4.5 + §4.8 timeline feed. Shared client/server. */

export const TagColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #6366f1')

export const CreateTagInput = z
  .object({
    name: z.string().trim().min(1, 'Tag name is required').max(40),
    color: TagColor.default('#6366f1'),
  })
  .strict()
export type CreateTagInputValue = z.infer<typeof CreateTagInput>

export const ReplaceTagsInput = z
  .object({
    tag_ids: z.array(z.string().uuid()).max(50),
  })
  .strict()

export const CreateNoteInput = z
  .object({
    applicant_id: z.string().uuid(),
    application_id: z.string().uuid().nullish(),
    body: z.string().trim().min(1, 'Note can’t be empty').max(5000),
  })
  .strict()
export type CreateNoteInputValue = z.infer<typeof CreateNoteInput>

export const UpdateApplicantInput = z
  .object({
    // docs/05 §4.4: `phone` only in Phase 2; null clears the field.
    phone: z.string().trim().max(40).nullable(),
  })
  .strict()

export const ListApplicantsQuery = z.object({
  q: z.string().max(120).optional(),
  tag_id: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type ListApplicantsQueryValue = z.infer<typeof ListApplicantsQuery>

export const ListTimelineQuery = z.object({
  applicant_id: z.string().uuid().optional(),
  application_id: z.string().uuid().optional(),
  type: z.enum(TIMELINE_EVENT_TYPES).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type ListTimelineQueryValue = z.infer<typeof ListTimelineQuery>

// ── Row shapes (DB) ────────────────────────────────────────────────────────────

export interface TagRow {
  id: string
  name: string
  color: string
  created_at: string
}

export interface NoteRow {
  id: string
  applicant_id: string
  application_id: string | null
  author_id: string
  body: string
  created_at: string
  updated_at: string
}

export interface ApplicantListRow {
  id: string
  full_name: string
  email: string
  phone: string | null
  source: string
  created_at: string
}

export interface ApplicantListItem extends ApplicantListRow {
  tags: TagRow[]
  applications_count: number
  last_applied_at: string | null
}

export interface ApplicantApplicationItem {
  id: string
  status: string
  applied_at: string
  job: { id: string; title: string }
}

export interface ApplicantDetail extends ApplicantListRow {
  tags: TagRow[]
  notes: NoteRow[]
  applications: ApplicantApplicationItem[]
  timeline: TimelineEventRow[]
}

/** Bulk PATCH /api/applications — docs/05 §4.3. */
export const BulkUpdateApplicationsInput = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(100),
    action: z.enum(['set_status', 'archive', 'add_tag']),
    value: z.string().max(100).default(''),
  })
  .strict()
export type BulkUpdateApplicationsInputValue = z.infer<typeof BulkUpdateApplicationsInput>
