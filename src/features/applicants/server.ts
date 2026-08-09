import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, ErrorCode } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import type {
  ApplicantApplicationItem,
  ApplicantDetail,
  ApplicantListItem,
  ApplicantListRow,
  CreateNoteInputValue,
  CreateTagInputValue,
  ListApplicantsQueryValue,
  ListTimelineQueryValue,
  NoteRow,
  TagRow,
} from '@/features/applicants/schemas'
import type { TimelineEventRow } from '@/features/applications/schemas'
import type { TimelineEventTypeValue } from '@/features/applications/constants'
import type { Scope } from '@/features/orgs/scope'
import { applyScope, filterApplicationIdsInScope } from '@/features/orgs/scope'

/**
 * Talent pool service — docs/02 §6–7, docs/05 §4.4–4.5.
 * Runs on the request-scoped (RLS) client: every query is owner-scoped by policy;
 * inserts still carry explicit owner_id to satisfy WITH CHECK clauses.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

/** PostgREST filter strings treat these as syntax — strip before embedding in ilike. */
export function sanitizeSearchTerm(q: string): string {
  return q
    .replace(/[%_(),."\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null
  const idx = cursor.lastIndexOf('_')
  if (idx <= 0) return null
  const [ts, id] = [cursor.slice(0, idx), cursor.slice(idx + 1)]
  return ts && id ? [ts, id] : null
}

// ── Tags (docs/05 §4.5; org-scoped per docs/11 §1) ────────────────────────────

export async function listTags(client: Client, scope: Scope): Promise<TagRow[]> {
  const { data, error } = await applyScope(
    client.from('tags').select('id, name, color, created_at'),
    scope,
  ).order('name', { ascending: true })
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load tags.', { cause: error })
  return (data ?? []) as unknown as TagRow[]
}

export async function createTag(
  client: Client,
  scope: Scope,
  input: CreateTagInputValue,
): Promise<TagRow> {
  const { data, error } = await client
    .from('tags')
    .insert({
      owner_id: scope.ownerId,
      organization_id: scope.kind === 'org' ? scope.orgId : null,
      name: input.name,
      color: input.color,
    })
    .select('id, name, color, created_at')
    .single()
  if (error) {
    if (error.code === '23505')
      throw new AppError(ErrorCode.CONFLICT, 'A tag with that name already exists.')
    throw new AppError(ErrorCode.INTERNAL, 'Could not create the tag.', { cause: error })
  }
  return data as unknown as TagRow
}

export async function deleteTag(client: Client, scope: Scope, id: string): Promise<void> {
  const { data, error } = await applyScope(client.from('tags').delete(), scope)
    .eq('id', id)
    .select('id')
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not delete the tag.', { cause: error })
  if (!data || data.length === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Tag not found.')
}

/** Batch tag lookup for list embeds — one query, no N+1 (docs/13 perf). */
export async function fetchTagsByApplicantIds(
  client: Client,
  applicantIds: string[],
): Promise<Map<string, TagRow[]>> {
  const map = new Map<string, TagRow[]>()
  if (applicantIds.length === 0) return map
  const { data, error } = await client
    .from('applicant_tags')
    .select('applicant_id, tag:tags(id, name, color, created_at)')
    .in('applicant_id', applicantIds)
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load tags.', { cause: error })
  for (const row of (data ?? []) as Array<{
    applicant_id: string
    tag: TagRow | TagRow[] | null
  }>) {
    const tag = Array.isArray(row.tag) ? row.tag[0] : row.tag
    if (!tag) continue
    const list = map.get(row.applicant_id) ?? []
    list.push(tag)
    map.set(row.applicant_id, list)
  }
  return map
}

// ── Applicants (docs/05 §4.4) ────────────────────────────────────────────────

async function applicantIdsForTag(client: Client, tagId: string): Promise<string[]> {
  const { data, error } = await client
    .from('applicant_tags')
    .select('applicant_id')
    .eq('tag_id', tagId)
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not filter by tag.', { cause: error })
  return ((data ?? []) as Array<{ applicant_id: string }>).map((r) => r.applicant_id)
}

export async function listApplicants(
  client: Client,
  scope: Scope,
  q: ListApplicantsQueryValue,
): Promise<{ data: ApplicantListItem[]; next_cursor: string | null }> {
  let tagApplicantIds: string[] | null = null
  if (q.tag_id) {
    tagApplicantIds = await applicantIdsForTag(client, q.tag_id)
    if (tagApplicantIds.length === 0) return { data: [], next_cursor: null }
  }

  let query = applyScope(
    client.from('applicants').select('id, full_name, email, phone, source, created_at'),
    scope,
  )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(Math.min(q.limit, 100) + 1)

  if (tagApplicantIds) query = query.in('id', tagApplicantIds)
  const term = q.q ? sanitizeSearchTerm(q.q) : ''
  if (term) {
    // Trigram GIN index (04 §4) serves the ilike; index usage kicks in ≥ ~3 chars.
    query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`)
  }
  const cursor = parseCursor(q.cursor)
  if (cursor) {
    const [createdAt, id] = cursor
    query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`)
  }

  const { data, error } = await query
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load applicants.', { cause: error })

  const rows = ((data ?? []) as unknown as ApplicantListRow[]).slice(0, q.limit)
  const hasMore = (data ?? []).length > q.limit
  const ids = rows.map((r) => r.id)

  const [tagsByApplicant, stats] = await Promise.all([
    fetchTagsByApplicantIds(client, ids),
    fetchApplicationStats(client, ids),
  ])

  const items: ApplicantListItem[] = rows.map((r) => ({
    ...r,
    tags: tagsByApplicant.get(r.id) ?? [],
    applications_count: stats.get(r.id)?.count ?? 0,
    last_applied_at: stats.get(r.id)?.last ?? null,
  }))

  const last = rows[rows.length - 1]
  return {
    data: items,
    next_cursor: hasMore && last ? `${last.created_at}_${last.id}` : null,
  }
}

async function fetchApplicationStats(
  client: Client,
  applicantIds: string[],
): Promise<Map<string, { count: number; last: string }>> {
  const map = new Map<string, { count: number; last: string }>()
  if (applicantIds.length === 0) return map
  const { data, error } = await client
    .from('applications')
    .select('applicant_id, applied_at')
    .in('applicant_id', applicantIds)
    .order('applied_at', { ascending: false })
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load application stats.', { cause: error })
  for (const row of (data ?? []) as Array<{ applicant_id: string; applied_at: string }>) {
    const entry = map.get(row.applicant_id) ?? { count: 0, last: row.applied_at }
    entry.count += 1
    if (row.applied_at > entry.last) entry.last = row.applied_at
    map.set(row.applicant_id, entry)
  }
  return map
}

export async function getApplicantDetail(
  client: Client,
  scope: Scope,
  id: string,
): Promise<ApplicantDetail | null> {
  const { data, error } = await applyScope(
    client
      .from('applicants')
      .select('id, full_name, email, phone, source, created_at, organization_id'),
    scope,
  )
    .eq('id', id)
    .maybeSingle()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the applicant.', { cause: error })
  if (!data) return null

  const [tagsByApplicant, applications, notes, timeline] = await Promise.all([
    fetchTagsByApplicantIds(client, [id]),
    client
      .from('applications')
      .select('id, status, applied_at, job:jobs!inner(id, title)')
      .eq('applicant_id', id)
      .order('applied_at', { ascending: false }),
    client
      .from('notes')
      .select('id, applicant_id, application_id, author_id, body, created_at, updated_at')
      .eq('applicant_id', id)
      .order('created_at', { ascending: false }),
    client
      .from('timeline_events')
      .select('id, type, payload, actor_id, created_at')
      .eq('applicant_id', id)
      .order('created_at', { ascending: false })
      .limit(100),
  ])
  if (applications.error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load applications.', {
      cause: applications.error,
    })
  if (notes.error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load notes.', { cause: notes.error })
  if (timeline.error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the timeline.', {
      cause: timeline.error,
    })

  return {
    ...(data as unknown as ApplicantListRow),
    tags: tagsByApplicant.get(id) ?? [],
    applications: (applications.data ?? []) as unknown as ApplicantApplicationItem[],
    notes: (notes.data ?? []) as unknown as NoteRow[],
    timeline: ((timeline.data ?? []) as unknown as TimelineEventRow[]).reverse(), // oldest → newest
  }
}

export async function updateApplicant(
  client: Client,
  scope: Scope,
  id: string,
  input: { phone: string | null },
): Promise<ApplicantListRow> {
  const { data, error } = await applyScope(
    client.from('applicants').update({ phone: input.phone?.trim() || null }),
    scope,
  )
    .eq('id', id)
    .select('id, full_name, email, phone, source, created_at')
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not update the applicant.', { cause: error })
  if (!data || data.length === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Applicant not found.')
  return data[0] as unknown as ApplicantListRow
}

/** Replace the applicant's tag set; journals tag_added/tag_removed per diff (docs/05 §4.5). */
export async function replaceApplicantTags(
  client: Client,
  scope: Scope,
  applicantId: string,
  tagIds: string[],
  actorId: string,
): Promise<TagRow[]> {
  const { data: applicant, error: applicantError } = await applyScope(
    client.from('applicants').select('id, owner_id, organization_id'),
    scope,
  )
    .eq('id', applicantId)
    .maybeSingle()
  if (applicantError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the applicant.', {
      cause: applicantError,
    })
  if (!applicant) throw new AppError(ErrorCode.NOT_FOUND, 'Applicant not found.')

  const current = (await fetchTagsByApplicantIds(client, [applicantId])).get(applicantId) ?? []
  const currentIds = new Set(current.map((t) => t.id))
  const targetIds = new Set(tagIds)

  // Every target tag must exist in THIS workspace (docs/05 §4.5 + 11 §1).
  let targetTags: TagRow[] = []
  if (targetIds.size > 0) {
    const { data, error } = await applyScope(
      client.from('tags').select('id, name, color, created_at'),
      scope,
    ).in('id', [...targetIds])
    if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load tags.', { cause: error })
    targetTags = (data ?? []) as unknown as TagRow[]
    if (targetTags.length !== targetIds.size) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'One or more tags do not exist.', {
        details: { tag_ids: ['Unknown tag id in the set.'] },
      })
    }
  }

  const added = targetTags.filter((t) => !currentIds.has(t.id))
  const removed = current.filter((t) => !targetIds.has(t.id))

  if (removed.length > 0) {
    const { error } = await client
      .from('applicant_tags')
      .delete()
      .eq('applicant_id', applicantId)
      .in(
        'tag_id',
        removed.map((t) => t.id),
      )
    if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not remove tags.', { cause: error })
  }
  if (added.length > 0) {
    const { error } = await client
      .from('applicant_tags')
      .insert(added.map((t) => ({ applicant_id: applicantId, tag_id: t.id })))
    if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not add tags.', { cause: error })
  }

  // Timeline journal: owner = acting user (workspace-partitioned feeds, docs/11 §5).
  const events = [
    ...added.map((t) => ({ type: 'tag_added' as const, tag: t })),
    ...removed.map((t) => ({ type: 'tag_removed' as const, tag: t })),
  ].map(({ type, tag }) => ({
    owner_id: actorId,
    applicant_id: applicantId,
    application_id: null,
    actor_id: actorId,
    type,
    payload: { tag_id: tag.id, tag_name: tag.name },
  }))
  if (events.length > 0) {
    const { error } = await client.from('timeline_events').insert(events)
    if (error)
      logger.error('tag events write failed', { applicant_id: applicantId, ...errorSummary(error) })
  }

  // Return the new set in α-order, matching listTags.
  return targetTags.sort((a, b) => a.name.localeCompare(b.name))
}

// ── Notes (docs/05 §4.5) ─────────────────────────────────────────────────────

export async function createNote(
  client: Client,
  scope: Scope,
  input: CreateNoteInputValue,
  actorId: string,
): Promise<NoteRow> {
  const { data: applicant, error: applicantError } = await applyScope(
    client.from('applicants').select('id, owner_id, organization_id'),
    scope,
  )
    .eq('id', input.applicant_id)
    .maybeSingle()
  if (applicantError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the applicant.', {
      cause: applicantError,
    })
  if (!applicant) throw new AppError(ErrorCode.NOT_FOUND, 'Applicant not found.')

  if (input.application_id) {
    const inScope = await filterApplicationIdsInScope(client, scope, [input.application_id])
    if (inScope.size === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')
    const { data: application, error: applicationError } = await client
      .from('applications')
      .select('id, applicant_id')
      .eq('id', input.application_id)
      .maybeSingle()
    if (applicationError)
      throw new AppError(ErrorCode.INTERNAL, 'Could not load the application.', {
        cause: applicationError,
      })
    if (!application) throw new AppError(ErrorCode.NOT_FOUND, 'Application not found.')
    if ((application as { applicant_id: string }).applicant_id !== input.applicant_id) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'That application does not belong to this applicant.',
        {
          details: { application_id: ['Applicant/application mismatch.'] },
        },
      )
    }
  }

  const { data, error } = await client
    .from('notes')
    .insert({
      owner_id: actorId, // notes belong to their author (org-shared via parent read, docs/11 §5)
      applicant_id: input.applicant_id,
      application_id: input.application_id ?? null,
      author_id: actorId,
      body: input.body,
    })
    .select('id, applicant_id, application_id, author_id, body, created_at, updated_at')
    .single()
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not save the note.', { cause: error })

  const note = data as unknown as NoteRow
  const { error: eventError } = await client.from('timeline_events').insert({
    owner_id: actorId,
    applicant_id: input.applicant_id,
    application_id: input.application_id ?? null,
    actor_id: actorId,
    type: 'note_added',
    payload: { note_id: note.id },
  })
  if (eventError)
    logger.error('note_added event write failed', { note_id: note.id, ...errorSummary(eventError) })
  return note
}

export async function deleteNote(client: Client, id: string): Promise<void> {
  const { data, error } = await client.from('notes').delete().eq('id', id).select('id')
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not delete the note.', { cause: error })
  if (!data || data.length === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Note not found.')
}

// ── Global timeline feed (docs/05 §4.8) ───────────────────────────────────────

export interface TimelineFeedItem extends TimelineEventRow {
  applicant: { id: string; full_name: string } | null
  application: { id: string; job: { id: string; title: string } | null } | null
}

/**
 * Scoped activity feed (docs/05 §4.8 + docs/11 §1 query rule). Events reference an
 * applicant, an application (via its job), or both — two scoped embed queries are
 * union-merged in JS (PostgREST can't OR two different inner-join filters in one query).
 * Cursor pagination applies to both branches identically before the merge.
 */
export async function listTimeline(
  client: Client,
  scope: Scope,
  q: ListTimelineQueryValue,
): Promise<{ data: TimelineFeedItem[]; next_cursor: string | null }> {
  // Explicit filters are scope-verified first; out-of-workspace targets → empty feed.
  if (q.applicant_id) {
    const { data: applicant } = await applyScope(client.from('applicants').select('id'), scope)
      .eq('id', q.applicant_id)
      .maybeSingle()
    if (!applicant) return { data: [], next_cursor: null }
  }
  if (q.application_id) {
    const allowed = await filterApplicationIdsInScope(client, scope, [q.application_id])
    if (allowed.size === 0) return { data: [], next_cursor: null }
  }

  const buildBranch = (via: 'applicant' | 'application') => {
    // Inner-driving embed gets the scope filters; the sibling embed stays a plain lookup.
    const select =
      via === 'applicant'
        ? 'id, type, payload, actor_id, created_at, applicant:applicants!inner(id, full_name), application:applications(id, job:jobs(id, title))'
        : 'id, type, payload, actor_id, created_at, applicant:applicants(id, full_name), application:applications!inner(id, job:jobs!inner(id, title))'
    let query = client
      .from('timeline_events')
      .select(select)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(q.limit + 1)

    if (scope.kind === 'org') {
      query =
        via === 'applicant'
          ? query.eq('applicant.organization_id', scope.orgId)
          : query.eq('application.job.organization_id', scope.orgId)
    } else {
      query =
        via === 'applicant'
          ? query.eq('applicant.owner_id', scope.ownerId).is('applicant.organization_id', null)
          : query
              .eq('application.job.owner_id', scope.ownerId)
              .is('application.job.organization_id', null)
    }

    if (q.applicant_id) query = query.eq('applicant_id', q.applicant_id)
    if (q.application_id) query = query.eq('application_id', q.application_id)
    if (q.type) query = query.eq('type', q.type as TimelineEventTypeValue)
    const cursor = parseCursor(q.cursor)
    if (cursor) {
      const [createdAt, id] = cursor
      query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`)
    }
    return query
  }

  const [aResult, bResult] = await Promise.all([
    buildBranch('applicant'),
    buildBranch('application'),
  ])
  if (aResult.error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the activity feed.', {
      cause: aResult.error,
    })
  if (bResult.error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the activity feed.', {
      cause: bResult.error,
    })

  // Union-merge by (created_at desc, id desc), dedupe by id (both-parent events appear twice).
  const merged = new Map<string, TimelineFeedItem & { created_at: string }>()
  for (const row of [
    ...((aResult.data ?? []) as unknown as Array<TimelineFeedItem & { created_at: string }>),
    ...((bResult.data ?? []) as unknown as Array<TimelineFeedItem & { created_at: string }>),
  ]) {
    const key = (row as { id?: string }).id ?? JSON.stringify(row)
    if (!merged.has(key)) merged.set(key, row)
  }
  const rows = [...merged.values()]
    .sort((x, y) =>
      x.created_at === y.created_at
        ? String((y as { id?: string }).id).localeCompare(String((x as { id?: string }).id))
        : y.created_at.localeCompare(x.created_at),
    )
    .slice(0, q.limit)

  const hadExtra =
    (aResult.data ?? []).length > q.limit ||
    (bResult.data ?? []).length > q.limit ||
    merged.size > q.limit
  const last = rows[rows.length - 1]
  return {
    data: rows as TimelineFeedItem[],
    next_cursor: hadExtra && last ? `${last.created_at}_${(last as { id?: string }).id}` : null,
  }
}

// ── CSV export (docs/05 §4.4) ─────────────────────────────────────────────────

export const EXPORT_MAX_ROWS = 10_000

/** Filter-resolved applicant rows for export (same shape/q rules as listApplicants). */
export async function listApplicantsForExport(
  client: Client,
  scope: Scope,
  q: Pick<ListApplicantsQueryValue, 'q' | 'tag_id'>,
): Promise<ApplicantListItem[]> {
  let tagApplicantIds: string[] | null = null
  if (q.tag_id) {
    tagApplicantIds = await applicantIdsForTag(client, q.tag_id)
    if (tagApplicantIds.length === 0) return []
  }

  let query = applyScope(
    client.from('applicants').select('id, full_name, email, phone, source, created_at'),
    scope,
  )
    .order('created_at', { ascending: false })
    .limit(EXPORT_MAX_ROWS)
  if (tagApplicantIds) query = query.in('id', tagApplicantIds)
  const term = q.q ? sanitizeSearchTerm(q.q) : ''
  if (term) query = query.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`)

  const { data, error } = await query
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not export applicants.', { cause: error })

  const rows = (data ?? []) as unknown as ApplicantListRow[]
  const ids = rows.map((r) => r.id)
  const [tagsByApplicant, stats] = await Promise.all([
    fetchTagsByApplicantIds(client, ids),
    fetchApplicationStats(client, ids),
  ])
  return rows.map((r) => ({
    ...r,
    tags: tagsByApplicant.get(r.id) ?? [],
    applications_count: stats.get(r.id)?.count ?? 0,
    last_applied_at: stats.get(r.id)?.last ?? null,
  }))
}
