import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, ErrorCode } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import type { StorageProvider } from '@/lib/storage/types'
import { StorageProviderError } from '@/lib/storage/types'
import {
  ApplicationStatus,
  type ApplicantRow,
  type ApplicationRow,
  type ApplicationStatusValue,
  type ApplyInputValue,
  type ListApplicationsQueryValue,
  type ResumeRow,
  type TimelineEventRow,
} from '@/features/applications/schemas'
import { buildResumeFilename, type ValidatedResume } from '@/features/applications/file-validation'
import type { ScreeningStatusValue } from '@/features/screening/schemas'
import type { JobRow } from '@/features/jobs/schemas'
import type {
  BulkUpdateApplicationsInputValue,
  NoteRow,
  TagRow,
} from '@/features/applicants/schemas'
import { fetchTagsByApplicantIds, sanitizeSearchTerm } from '@/features/applicants/server'
import { decodeSummaryCache } from '@/features/ai/schemas'
import type { Scope } from '@/features/orgs/scope'
import {
  filterApplicationIdsInScope,
  isRowInScope,
  jobEmbedFilters,
  withFilters,
} from '@/features/orgs/scope'

/**
 * Applications service — the critical path, docs/03 §5, docs/02 §4.
 * Sequencing is normative: DB tx semantics first, external calls absorbed, every
 * side-effect journaled to timeline_events.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

const UPLOAD_RETRY_DELAY_MS = 5_000 // docs/07 §5: 1 retry, 5s backoff

// docs/07 §4: resumes for jobs with a mandatory questionnaire route into a
// verdict subfolder under the job folder; jobs with no mandatory questions
// (verdict null) stay flat, matching the pre-questionnaire layout.
const VERDICT_FOLDER_LABEL: Record<ScreeningStatusValue, string> = {
  qualified: 'Qualified',
  does_not_meet_mandatory: 'Not Qualified',
  review_required: 'Needs Review',
}

export interface CreateApplicationResult {
  applicationId: string
  applicantId: string
  jobTitle: string
  applicantName: string
  applicantEmail: string
  applicantPhone: string | null
  alreadyApplied: boolean
  resumeUploaded: boolean
  resumeFailed: boolean
}

/**
 * Create an application for a job — public apply path (service client REQUIRED:
 * every insert here carries explicit owner/scope values, docs/03 §Rules).
 *
 * Idempotent per (job_id, applicant.email) — D8: a duplicate submission returns
 * `alreadyApplied: true` with NO side effects (docs/02 §4.5).
 */
export async function createApplicationForJob(
  client: Client,
  job: Pick<JobRow, 'id' | 'owner_id' | 'title' | 'drive_folder_id'> & {
    id: string
    organization_id?: string | null
  },
  input: ApplyInputValue,
  resume: { data: Buffer; originalName: string; validated: ValidatedResume } | null,
  drive: { storage: StorageProvider; integrationId: string } | null,
  screeningVerdict: ScreeningStatusValue | null,
): Promise<CreateApplicationResult> {
  const ownerId = job.owner_id
  const jobOrg = job.organization_id ?? null

  // 1) Upsert applicant — org-first dedupe (docs/11 §6): the insert targets the job's
  // workspace; a unique collision (0006 partial indexes: per-owner-personal or per-org)
  // falls through to a lookup, and a personal match for an ORG job is re-scoped into
  // the org pool (shared talent pool wins). A match for a PERSONAL job reuses whatever
  // row exists — workspace of the applicant row is kept (documented edge in 11 §6).
  const email = input.email.trim().toLowerCase()
  let applicant: ApplicantRow
  let applicantCreated = false
  const { data: createdApplicant, error: applicantInsertError } = await client
    .from('applicants')
    .insert({
      owner_id: ownerId,
      organization_id: jobOrg,
      full_name: input.full_name.trim(),
      email,
      phone: input.phone?.trim() || null,
      source: input.source,
    })
    .select('id, full_name, email, phone, source, organization_id')
    .single()

  if (applicantInsertError) {
    if (applicantInsertError.code !== '23505') {
      throw new AppError(ErrorCode.INTERNAL, 'Could not register the applicant.', {
        cause: applicantInsertError,
      })
    }
    const { data: candidates, error: loadError } = await client
      .from('applicants')
      .select('id, full_name, email, phone, source, owner_id, organization_id')
      .eq('email', email)
      .or(jobOrg ? `organization_id.eq.${jobOrg},owner_id.eq.${ownerId}` : `owner_id.eq.${ownerId}`)
    if (loadError) {
      throw new AppError(ErrorCode.INTERNAL, 'Could not load the applicant.', { cause: loadError })
    }
    const rows = (candidates ?? []) as Array<
      ApplicantRow & { owner_id: string; organization_id: string | null }
    >
    const chosen =
      rows.find((r) => (r.organization_id ?? null) === jobOrg) ??
      rows.find((r) => r.owner_id === ownerId || r.organization_id === null) ??
      rows[0]
    if (!chosen) {
      // Should be unreachable given the 23505 above (unless the row vanished mid-race).
      throw new AppError(ErrorCode.INTERNAL, 'Could not register the applicant.')
    }
    // Re-scope a personal row into the org pool when the apply came through an org job.
    if (jobOrg && chosen.organization_id === null) {
      const { error: rescopeError } = await client
        .from('applicants')
        .update({ organization_id: jobOrg })
        .eq('id', chosen.id)
        .is('organization_id', null) // guard: only ever re-scope personal rows
      if (rescopeError) {
        logger.warn('applicant org re-scope skipped (continuing with shared row)', {
          applicant_id: chosen.id,
          ...errorSummary(rescopeError),
        })
      }
    }
    applicant = chosen as unknown as ApplicantRow
  } else {
    applicant = createdApplicant as unknown as ApplicantRow
    applicantCreated = true
  }

  // 2) Insert application; unique (job_id, applicant_id) makes this idempotent (docs/04 §3.5).
  const { data: application, error: applicationError } = await client
    .from('applications')
    .insert({
      job_id: job.id,
      applicant_id: applicant.id,
      status: 'new',
      source_meta: {},
    })
    .select('id, job_id, applicant_id, status, source_meta, applied_at, updated_at')
    .single()

  if (applicationError) {
    if (applicationError.code === '23505') {
      return {
        applicationId: '',
        applicantId: applicant.id,
        jobTitle: job.title,
        applicantName: applicant.full_name,
        applicantEmail: applicant.email,
        applicantPhone: applicant.phone,
        alreadyApplied: true,
        resumeUploaded: false,
        resumeFailed: false,
      }
    }
    throw new AppError(ErrorCode.INTERNAL, 'Could not save your application.', {
      cause: applicationError,
    })
  }
  const app = application as unknown as ApplicationRow

  // 3) Timeline journal — application_created (+ applicant_created if new).
  const events: Array<Record<string, unknown>> = [
    {
      owner_id: ownerId,
      applicant_id: applicant.id,
      application_id: app.id,
      actor_id: null,
      type: 'application_created',
      payload: { source: input.source },
    },
  ]
  if (applicantCreated) {
    events.push({
      owner_id: ownerId,
      applicant_id: applicant.id,
      application_id: null,
      actor_id: null,
      type: 'applicant_created',
      payload: {},
    })
  }
  await client.from('timeline_events').insert(events)

  // 4) Resume — docs/03 §5: attempt synchronously; failures are ABSORBED (D4).
  let resumeUploaded = false
  let resumeFailed = false
  if (resume) {
    if (!drive) {
      resumeFailed = true
      logger.warn('resume dropped: no Drive integration', { owner_id: ownerId })
    } else {
      try {
        const jobFolderId = await ensureJobFolderCached(client, job, drive.storage)
        // Verdict subfolder only when this job actually has a mandatory questionnaire
        // (screeningVerdict is null otherwise) — jobs with no questionnaire stay flat.
        const folderId = screeningVerdict
          ? (await drive.storage.ensureFolder(VERDICT_FOLDER_LABEL[screeningVerdict], jobFolderId))
              .folderId
          : jobFolderId
        const filename = buildResumeFilename({
          applicantName: applicant.full_name,
          originalName: resume.originalName,
          type: resume.validated.type,
        })
        const uploaded = await uploadWithRetry(drive.storage, {
          folderId,
          filename,
          mime: resume.validated.mime,
          data: resume.data,
        })
        await client.from('resumes').insert({
          application_id: app.id,
          applicant_id: applicant.id,
          storage_provider: 'google_drive',
          storage_file_id: uploaded.fileId,
          original_filename: resume.originalName,
          mime_type: resume.validated.mime,
          size_bytes: resume.validated.sizeBytes,
          upload_status: 'uploaded',
        })
        await client.from('timeline_events').insert({
          owner_id: ownerId,
          applicant_id: applicant.id,
          application_id: app.id,
          actor_id: null,
          type: 'resume_uploaded',
          payload: { file_id: uploaded.fileId, size_bytes: resume.validated.sizeBytes },
        })
        resumeUploaded = true
      } catch (err) {
        // D4 + docs/03 §6: application stands; journal the failure; owner is alerted.
        resumeFailed = true
        logger.error('resume upload failed after retries', {
          owner_id: ownerId,
          ...errorSummary(err),
        })
        if (err instanceof StorageProviderError && err.integrationBroken && drive.integrationId) {
          await client
            .from('integrations')
            .update({ status: 'error' })
            .eq('id', drive.integrationId)
        }
        await client.from('resumes').insert({
          application_id: app.id,
          applicant_id: applicant.id,
          storage_provider: 'google_drive',
          storage_file_id: null,
          original_filename: resume.originalName,
          mime_type: resume.validated.mime,
          size_bytes: resume.validated.sizeBytes,
          upload_status: 'failed',
        })
        await client.from('timeline_events').insert({
          owner_id: ownerId,
          applicant_id: applicant.id,
          application_id: app.id,
          actor_id: null,
          type: 'resume_failed',
          payload: { reason: 'drive_upload_failed' },
        })
      }
    }
  }

  return {
    applicationId: app.id,
    applicantId: applicant.id,
    jobTitle: job.title,
    applicantName: applicant.full_name,
    applicantEmail: applicant.email,
    applicantPhone: applicant.phone,
    alreadyApplied: false,
    resumeUploaded,
    resumeFailed,
  }
}

/** docs/07 §4 — folder id cached on jobs.drive_folder_id so repeat uploads skip re-creation. */
async function ensureJobFolderCached(
  client: Client,
  job: Pick<JobRow, 'id' | 'title' | 'drive_folder_id'>,
  storage: StorageProvider,
): Promise<string> {
  if (job.drive_folder_id) return job.drive_folder_id
  const { folderId } = await storage.ensureJobFolder({ id: job.id, title: job.title })
  await client.from('jobs').update({ drive_folder_id: folderId }).eq('id', job.id)
  return folderId
}

/** docs/07 §5 timeouts: single retry with 5s backoff, only for retryable failures. */
async function uploadWithRetry(
  storage: StorageProvider,
  input: { folderId: string; filename: string; mime: string; data: Buffer },
) {
  try {
    return await storage.uploadFile(input)
  } catch (err) {
    if (!(err instanceof StorageProviderError) || !err.retryable) throw err
    await new Promise((r) => setTimeout(r, UPLOAD_RETRY_DELAY_MS))
    return storage.uploadFile(input)
  }
}

// ── Owner-side reads/writes (RLS via request-scoped client) ────────────────────

export interface ApplicationListItem extends ApplicationRow {
  applicant: ApplicantRow
  job: { id: string; title: string }
  has_resume: boolean
  resume_failed: boolean
  tags: TagRow[]
}

/** docs/05 §4.3 GET /api/applications — default = inbox (`new`, all jobs, newest first).
 *  Scoped via the jobs!inner embed (docs/11 §1 query rule) — no giant id lists. */
export async function listApplications(
  client: Client,
  scope: Scope,
  q: ListApplicationsQueryValue,
): Promise<{ data: ApplicationListItem[]; next_cursor: string | null }> {
  // Tag filter (02 §6): resolve applicant ids carrying the tag first.
  let tagApplicantIds: string[] | null = null
  if (q.tag_id) {
    const { data: tagRows, error: tagError } = await client
      .from('applicant_tags')
      .select('applicant_id')
      .eq('tag_id', q.tag_id)
    if (tagError)
      throw new AppError(ErrorCode.INTERNAL, 'Could not filter by tag.', { cause: tagError })
    tagApplicantIds = ((tagRows ?? []) as Array<{ applicant_id: string }>).map(
      (r) => r.applicant_id,
    )
    if (tagApplicantIds.length === 0) return { data: [], next_cursor: null }
  }

  let query = withFilters(
    client
      .from('applications')
      .select(
        '*, applicant:applicants!inner(id, full_name, email, phone, source), job:jobs!inner(id, title), resumes(upload_status)',
      )
      .order('applied_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(q.limit + 1),
    jobEmbedFilters(scope),
  )

  if (q.job_id) query = query.eq('job_id', q.job_id)
  if (tagApplicantIds) query = query.in('applicant_id', tagApplicantIds)
  if (q.status && q.status.length > 0) query = query.in('status', q.status)
  else query = query.eq('status', 'new')
  const term = q.q ? sanitizeSearchTerm(q.q) : ''
  if (term) {
    // Full-text over applicant name/email (04 §4 trigram index), docs/05 §4.3.
    query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`, {
      referencedTable: 'applicant',
    })
  }
  if (q.date_from) query = query.gte('applied_at', `${q.date_from}T00:00:00.000Z`)
  if (q.date_to) query = query.lte('applied_at', `${q.date_to}T23:59:59.999Z`)
  if (q.cursor) {
    const [appliedAt, id] = q.cursor.split('_')
    if (appliedAt && id) {
      query = query.or(`applied_at.lt.${appliedAt},and(applied_at.eq.${appliedAt},id.lt.${id})`)
    }
  }

  const { data, error } = await query
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load applications.', { cause: error })

  const rows = (data ?? []).slice(0, q.limit)
  const hasMore = (data ?? []).length > q.limit

  const applicantIds = [
    ...new Set(
      rows.map((r) => (r as Record<string, unknown>).applicant_id as string).filter(Boolean),
    ),
  ]
  const tagsByApplicant = await fetchTagsByApplicantIds(client, applicantIds)

  const items: ApplicationListItem[] = rows.map((row) => {
    const r = row as Record<string, unknown>
    const resumes = (r.resumes as Array<{ upload_status: string }> | null) ?? []
    const applicant = r.applicant as unknown as ApplicantRow
    return {
      ...(r as unknown as ApplicationRow),
      applicant,
      job: r.job as { id: string; title: string },
      has_resume: resumes.some((x) => x.upload_status === 'uploaded'),
      resume_failed: resumes.some((x) => x.upload_status === 'failed'),
      tags: tagsByApplicant.get(applicant.id) ?? [],
    }
  })

  const last = rows[rows.length - 1] as { applied_at: string; id: string } | undefined
  return {
    data: items,
    next_cursor: hasMore && last ? `${last.applied_at}_${last.id}` : null,
  }
}

export interface ApplicationDetail extends ApplicationRow {
  applicant: ApplicantRow
  job: { id: string; title: string; slug: string }
  resumes: ResumeRow[]
  timeline: TimelineEventRow[]
  notes: NoteRow[]
  tags: TagRow[]
  cover_note: string | null
  /** Decoded applicants.ai_summary cache (docs/10 §3) — null when never generated. */
  ai_summary: { summary: string; strengths: string[]; generated_at: string } | null
}

/** docs/05 §4.3 GET /api/applications/:id — full detail incl. latest 100 timeline events.
 *  Scope-verified via the parent job (docs/11 §1): out-of-workspace id → null (404). */
export async function getApplicationDetail(
  client: Client,
  scope: Scope,
  id: string,
): Promise<ApplicationDetail | null> {
  const { data, error } = await client
    .from('applications')
    .select(
      '*, applicant:applicants(id, full_name, email, phone, source, ai_summary), job:jobs!inner(id, title, slug, owner_id, organization_id), resumes(id, application_id, storage_file_id, original_filename, mime_type, size_bytes, upload_status)',
    )
    .eq('id', id)
    .maybeSingle()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the application.', { cause: error })
  if (!data) return null

  const row = data as Record<string, unknown>
  const jobRow = row.job as { owner_id: string; organization_id: string | null }
  if (!isRowInScope(jobRow, scope)) return null
  const applicantId = (row.applicant as { id: string }).id

  const [timelineResult, notesResult, tagsByApplicant] = await Promise.all([
    client
      .from('timeline_events')
      .select('id, type, payload, actor_id, created_at')
      .eq('application_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
    client
      .from('notes')
      .select('id, applicant_id, application_id, author_id, body, created_at, updated_at')
      .eq('applicant_id', applicantId)
      .order('created_at', { ascending: false }),
    fetchTagsByApplicantIds(client, [applicantId]),
  ])
  if (timelineResult.error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the timeline.', {
      cause: timelineResult.error,
    })
  if (notesResult.error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load notes.', { cause: notesResult.error })

  return {
    ...(row as unknown as ApplicationRow),
    applicant: row.applicant as unknown as ApplicantRow,
    job: row.job as { id: string; title: string; slug: string },
    resumes: (row.resumes as unknown as ResumeRow[]) ?? [],
    timeline: ((timelineResult.data as unknown as TimelineEventRow[]) ?? []).reverse(),
    notes: (notesResult.data as unknown as NoteRow[]) ?? [],
    tags: tagsByApplicant.get(applicantId) ?? [],
    cover_note: ((row.source_meta as Record<string, unknown> | null)?.cover_note as string) ?? null,
    ai_summary: decodeSummaryCache(
      ((row.applicant as { ai_summary?: string | null }).ai_summary as string | null) ?? null,
    ),
  }
}

/** docs/05 §4.3 PATCH — status change with status_changed journal (from/to). Scoped. */
export async function updateApplicationStatus(
  client: Client,
  scope: Scope,
  id: string,
  toStatus: ApplicationStatusValue,
  actorId: string,
): Promise<ApplicationRow & { applicant: ApplicantRow; job: { id: string; title: string } }> {
  const { data: current, error: loadError } = await client
    .from('applications')
    .select(
      '*, applicant:applicants(id, full_name, email, phone, source), job:jobs!inner(id, title, owner_id, organization_id)',
    )
    .eq('id', id)
    .maybeSingle()
  if (loadError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the application.', { cause: loadError })
  if (!current) throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')

  const row = current as Record<string, unknown>
  const jobRow = row.job as { owner_id: string; organization_id: string | null }
  if (!isRowInScope(jobRow, scope))
    throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')

  const fromStatus = (current as { status: ApplicationStatusValue }).status
  if (fromStatus === toStatus) {
    return current as unknown as ApplicationRow & {
      applicant: ApplicantRow
      job: { id: string; title: string }
    }
  }
  const jobOwnerId = jobRow.owner_id

  const { data: updated, error: updateError } = await client
    .from('applications')
    .update({ status: toStatus })
    .eq('id', id)
    .select(
      '*, applicant:applicants(id, full_name, email, phone, source), job:jobs!inner(id, title)',
    )
    .single()
  if (updateError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not update the status.', { cause: updateError })

  const { error: eventError } = await client.from('timeline_events').insert({
    owner_id: jobOwnerId,
    applicant_id: row.applicant_id as string,
    application_id: id,
    actor_id: actorId,
    type: 'status_changed',
    payload: { from: fromStatus, to: toStatus },
  })
  if (eventError) {
    logger.error('status_changed event write failed', {
      application_id: id,
      ...errorSummary(eventError),
    })
  }

  return updated as unknown as ApplicationRow & {
    applicant: ApplicantRow
    job: { id: string; title: string }
  }
}

// ── Bulk actions + delete (Phase 2 — docs/05 §4.3, docs/02 §6) ───────────────

export interface BulkResult {
  updated: number
  failed_ids: string[]
}

/**
 * Bulk status/archive/tag — docs/05 §4.3: none-some atomic per row; per-row
 * failures are collected in `failed_ids`, never thrown. set_status/archive reuse
 * updateApplicationStatus so every change is journaled (status_changed).
 */
export async function bulkUpdateApplications(
  client: Client,
  scope: Scope,
  input: BulkUpdateApplicationsInputValue,
  actorId: string,
): Promise<BulkResult> {
  if (input.action === 'add_tag') {
    return bulkAddTag(client, scope, input.ids, input.value, actorId)
  }

  const toStatus: ApplicationStatusValue =
    input.action === 'archive'
      ? 'archived'
      : (() => {
          const parsed = ApplicationStatus.safeParse(input.value)
          if (!parsed.success) {
            throw new AppError(ErrorCode.VALIDATION_ERROR, 'Unknown status for bulk update.', {
              details: { value: ['Must be a valid application status.'] },
            })
          }
          return parsed.data
        })()

  const failedIds: string[] = []
  let updated = 0
  for (const id of input.ids) {
    try {
      await updateApplicationStatus(client, scope, id, toStatus, actorId)
      updated += 1
    } catch (err) {
      // NOT_FOUND = row vanished mid-batch (per-row semantics, docs/05 §4.3);
      // INTERNAL surprises are logged but still reported per-row to the caller.
      logger.warn('bulk row failed', { application_id: id, ...errorSummary(err) })
      failedIds.push(id)
    }
  }
  return { updated, failed_ids: failedIds }
}

async function bulkAddTag(
  client: Client,
  scope: Scope,
  ids: string[],
  tagId: string,
  actorId: string,
): Promise<BulkResult> {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRe.test(tagId)) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'add_tag requires a tag id in `value`.', {
      details: { value: ['Must be a tag UUID.'] },
    })
  }
  const { data: tag, error: tagError } = await client
    .from('tags')
    .select('id, name, owner_id, organization_id')
    .eq('id', tagId)
    .maybeSingle()
  if (tagError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the tag.', { cause: tagError })
  if (!tag) throw new AppError(ErrorCode.NOT_FOUND, 'Tag not found.')
  if (!isRowInScope(tag as { owner_id: string; organization_id: string | null }, scope)) {
    throw new AppError(ErrorCode.NOT_FOUND, 'Tag not found.')
  }

  // Scope-filter the ids first (docs/11 §1): out-of-workspace ids count as per-row failures.
  const allowed = await filterApplicationIdsInScope(client, scope, ids)
  const { data: apps, error: appsError } = await client
    .from('applications')
    .select('id, applicant_id')
    .in(
      'id',
      ids.filter((id) => allowed.has(id)),
    )
  if (appsError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load applications.', { cause: appsError })

  const rows = (apps ?? []) as Array<{ id: string; applicant_id: string }>
  const found = new Set(rows.map((r) => r.id))
  const failedIds = ids.filter((id) => !found.has(id))
  const applicantIds = [...new Set(rows.map((r) => r.applicant_id))]
  if (applicantIds.length === 0) return { updated: 0, failed_ids: failedIds }

  const { error: upsertError } = await client.from('applicant_tags').upsert(
    applicantIds.map((applicantId) => ({ applicant_id: applicantId, tag_id: tagId })),
    { onConflict: 'applicant_id,tag_id', ignoreDuplicates: true },
  )
  if (upsertError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not apply the tag.', { cause: upsertError })

  const ownerId = (tag as { owner_id: string }).owner_id
  const events = applicantIds.map((applicantId) => ({
    owner_id: ownerId,
    applicant_id: applicantId,
    application_id: null,
    actor_id: actorId,
    type: 'tag_added',
    payload: { tag_id: tagId, tag_name: (tag as { name: string }).name },
  }))
  const { error: eventError } = await client.from('timeline_events').insert(events)
  if (eventError) logger.error('bulk tag events write failed', { ...errorSummary(eventError) })

  return { updated: rows.length, failed_ids: failedIds }
}

/**
 * Delete an application — docs/05 §4.3 + docs/07 §7: DB cascades; Drive files
 * REMAIN (owner may need them for compliance) and the client confirms first.
 * The deletion is journaled on the applicant (application rows are gone).
 */
export async function deleteApplication(
  client: Client,
  scope: Scope,
  id: string,
  actorId: string,
): Promise<{ ok: true; drive_files_kept: boolean }> {
  const { data: current, error: loadError } = await client
    .from('applications')
    .select(
      'id, status, job_id, applicant_id, job:jobs!inner(owner_id, organization_id), resumes(upload_status)',
    )
    .eq('id', id)
    .maybeSingle()
  if (loadError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the application.', { cause: loadError })
  if (!current) throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')

  const row = current as Record<string, unknown>
  const jobRow = row.job as { owner_id: string; organization_id: string | null }
  if (!isRowInScope(jobRow, scope))
    throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')
  const resumes = (row.resumes as Array<{ upload_status: string }> | null) ?? []
  const driveFilesKept = resumes.some((r) => r.upload_status === 'uploaded')
  const ownerId = jobRow.owner_id

  const { error: deleteError } = await client.from('applications').delete().eq('id', id)
  if (deleteError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not delete the application.', {
      cause: deleteError,
    })

  const { error: eventError } = await client.from('timeline_events').insert({
    owner_id: ownerId,
    applicant_id: row.applicant_id as string,
    application_id: null, // the application no longer exists; events linked to it cascaded
    actor_id: actorId,
    type: 'application_deleted',
    payload: {
      application_id: id,
      job_id: row.job_id,
      from_status: row.status,
      drive_files_kept: driveFilesKept,
    },
  })
  if (eventError)
    logger.error('application_deleted event write failed', { ...errorSummary(eventError) })

  return { ok: true, drive_files_kept: driveFilesKept }
}

/** Owner profile toggles + email for notifications (apply flow, service client). */
export async function getOwnerNotificationPrefs(
  client: Client,
  ownerId: string,
): Promise<{
  email: string
  notifyTelegram: boolean
  notifyApplicantEmail: boolean
  name: string | null
} | null> {
  const { data, error } = await client
    .from('users')
    .select('email, full_name, notify_telegram, notify_applicant_email')
    .eq('id', ownerId)
    .maybeSingle()
  if (error || !data) return null
  const u = data as {
    email: string
    full_name: string | null
    notify_telegram: boolean
    notify_applicant_email: boolean
  }
  return {
    email: u.email,
    notifyTelegram: u.notify_telegram,
    notifyApplicantEmail: u.notify_applicant_email,
    name: u.full_name,
  }
}
