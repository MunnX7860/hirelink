/**
 * Resume file rules — docs/05 §5. Deliberately ZOD-FREE so the public apply page
 * can import them without shipping zod (docs/06 §8 route-JS budget).
 */
export const RESUME_MAX_BYTES = 10_485_760
export const RESUME_MIME_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
}

/**
 * timeline_event_type enum values — docs/04 §3.8 + migration 0001/0005.
 * Zod-free so any bundle can validate display strings.
 */
export const TIMELINE_EVENT_TYPES = [
  'application_created',
  'status_changed',
  'note_added',
  'tag_added',
  'tag_removed',
  'resume_uploaded',
  'resume_failed',
  'email_sent',
  'email_failed',
  'telegram_sent',
  'telegram_failed',
  'ai_summary_generated',
  'applicant_created',
  'application_deleted',
] as const
export type TimelineEventTypeValue = (typeof TIMELINE_EVENT_TYPES)[number]
