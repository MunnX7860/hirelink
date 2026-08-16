import { describe, expect, it } from 'vitest'
import {
  BulkUpdateApplicationsInput,
  CreateNoteInput,
  CreateTagInput,
  ListApplicantsQuery,
  ListTimelineQuery,
  ReplaceTagsInput,
  TagColor,
  UpdateApplicantInput,
} from '@/features/applicants/schemas'
import { ListApplicationsQuery } from '@/features/applications/schemas'
import { parseCursor, sanitizeSearchTerm } from '@/features/applicants/server'

const uuid = () => crypto.randomUUID()

describe('tag schemas (docs/05 §4.5)', () => {
  it('CreateTagInput trims + defaults the brand color', () => {
    const v = CreateTagInput.parse({ name: '  Re-apply Q3  ' })
    expect(v.name).toBe('Re-apply Q3')
    expect(v.color).toBe('#6366f1')
  })

  it('TagColor enforces 6-digit hex', () => {
    expect(TagColor.safeParse('#16a34a').success).toBe(true)
    expect(TagColor.safeParse('#16A34F').success).toBe(true)
    expect(TagColor.safeParse('red').success).toBe(false)
    expect(TagColor.safeParse('#12345').success).toBe(false)
    expect(TagColor.safeParse('#1234567').success).toBe(false)
  })

  it('CreateTagInput rejects over-long names and unknown keys', () => {
    expect(CreateTagInput.safeParse({ name: 'x'.repeat(41) }).success).toBe(false)
    expect(CreateTagInput.safeParse({ name: 'ok', hack: true }).success).toBe(false)
  })

  it('ReplaceTagsInput requires uuid tag ids (≤50)', () => {
    expect(ReplaceTagsInput.safeParse({ tag_ids: [uuid(), uuid()] }).success).toBe(true)
    expect(ReplaceTagsInput.safeParse({ tag_ids: ['nope'] }).success).toBe(false)
    expect(ReplaceTagsInput.safeParse({ tag_ids: Array.from({ length: 51 }, uuid) }).success).toBe(
      false,
    )
  })
})

describe('note schemas (docs/05 §4.5)', () => {
  it('CreateNoteInput trims, allows null application_id, caps at 5000', () => {
    const applicant = uuid()
    const v = CreateNoteInput.parse({ applicant_id: applicant, application_id: null, body: ' hi ' })
    expect(v.body).toBe('hi')
    expect(CreateNoteInput.safeParse({ applicant_id: applicant, body: '' }).success).toBe(false)
    expect(
      CreateNoteInput.safeParse({ applicant_id: applicant, body: 'x'.repeat(5001) }).success,
    ).toBe(false)
  })
})

describe('applicant query schemas (docs/05 §4.4)', () => {
  it('ListApplicantsQuery coerces limit + defaults 50', () => {
    const v = ListApplicantsQuery.parse({ limit: '25' })
    expect(v.limit).toBe(25)
    expect(ListApplicantsQuery.parse({}).limit).toBe(50)
    expect(ListApplicantsQuery.safeParse({ limit: '0' }).success).toBe(false)
    expect(ListApplicantsQuery.safeParse({ limit: '101' }).success).toBe(false)
  })

  it('UpdateApplicantInput allows clearing phone with null only', () => {
    expect(UpdateApplicantInput.safeParse({ phone: null }).success).toBe(true)
    expect(UpdateApplicantInput.safeParse({ phone: '+91 9999999999' }).success).toBe(true)
    expect(UpdateApplicantInput.safeParse({}).success).toBe(false)
    expect(UpdateApplicantInput.safeParse({ phone: undefined }).success).toBe(false)
  })

  it('ListTimelineQuery validates the event type enum', () => {
    expect(ListTimelineQuery.safeParse({ type: 'note_added' }).success).toBe(true)
    expect(ListTimelineQuery.safeParse({ type: 'hacked_type' }).success).toBe(false)
  })
})

describe('bulk input (docs/05 §4.3)', () => {
  it('caps ids at 100 and validates the action enum', () => {
    expect(
      BulkUpdateApplicationsInput.safeParse({
        ids: [uuid()],
        action: 'set_status',
        value: 'shortlisted',
      }).success,
    ).toBe(true)
    expect(
      BulkUpdateApplicationsInput.safeParse({
        ids: Array.from({ length: 101 }, uuid),
        action: 'archive',
        value: '',
      }).success,
    ).toBe(false)
    expect(
      BulkUpdateApplicationsInput.safeParse({ ids: [uuid()], action: 'delete', value: '' }).success,
    ).toBe(false)
    expect(
      BulkUpdateApplicationsInput.safeParse({ ids: [], action: 'archive', value: '' }).success,
    ).toBe(false)
  })
})

describe('applications list query (docs/05 §4.3 + 02 §6 filters)', () => {
  it('takes tag_id and ISO date range', () => {
    const v = ListApplicationsQuery.parse({
      tag_id: uuid(),
      date_from: '2026-08-01',
      date_to: '2026-08-08',
    })
    expect(v.date_from).toBe('2026-08-01')
    expect(ListApplicationsQuery.safeParse({ date_from: '08/01/2026' }).success).toBe(false)
    expect(ListApplicationsQuery.safeParse({ date_from: '2026-13-40' }).success).toBe(false)
  })

  it('status comma-splits through the enum', () => {
    const v = ListApplicationsQuery.parse({ status: 'new,reviewing' })
    expect(v.status).toEqual(['new', 'reviewing'])
    expect(ListApplicationsQuery.safeParse({ status: 'new,nah' }).success).toBe(false)
  })

  it('screening comma-splits through the verdict enum plus the "none" sentinel', () => {
    const v = ListApplicationsQuery.parse({ screening: 'qualified,does_not_meet_mandatory' })
    expect(v.screening).toEqual(['qualified', 'does_not_meet_mandatory'])
    // 'none' is not a screening_status value — it selects the NULL verdict
    // (jobs with no mandatory questionnaire), which the enum alone can't express.
    expect(ListApplicationsQuery.parse({ screening: 'none' }).screening).toEqual(['none'])
    expect(ListApplicationsQuery.parse({ screening: 'qualified,none' }).screening).toEqual([
      'qualified',
      'none',
    ])
    expect(ListApplicationsQuery.safeParse({ screening: 'qualified,bogus' }).success).toBe(false)
    // Absent means "no verdict filter", never an empty-set match-nothing.
    expect(ListApplicationsQuery.parse({}).screening).toBeUndefined()
  })
})

describe('search sanitiser + cursor helpers', () => {
  it('sanitizeSearchTerm strips PostgREST filter syntax', () => {
    expect(sanitizeSearchTerm('ada, (dev) "x" %_\\.')).toBe('ada dev x')
    expect(sanitizeSearchTerm('  spaced   out ')).toBe('spaced out')
    expect(sanitizeSearchTerm('(,)')).toBe('')
  })

  it('parseCursor round-trips ts_id and tolerates ids containing dashes', () => {
    const id = uuid()
    expect(parseCursor(`2026-08-08T10:00:00.000Z_${id}`)).toEqual(['2026-08-08T10:00:00.000Z', id])
    expect(parseCursor(undefined)).toBeNull()
    expect(parseCursor('')).toBeNull()
    expect(parseCursor('_')).toBeNull()
  })
})
