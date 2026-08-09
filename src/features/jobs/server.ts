import 'server-only'

import { customAlphabet } from 'nanoid'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, ErrorCode } from '@/lib/errors'
import {
  canTransitionJob,
  type CreateJobInputValue,
  type JobRow,
  type UpdateJobInputType,
  type PublicJob,
  type JobStatusValue,
} from '@/features/jobs/types'
import type { Scope } from '@/features/orgs/scope'
import { applyScope } from '@/features/orgs/scope'
import { assertWithinPlan, countActiveJobs, loadPlanForScope } from '@/features/orgs/server'

/**
 * Jobs service — docs/02 §2–§3, docs/05 §4.1, Phase 4 scoping docs/11 §1/§4.
 * All functions receive the Supabase client from the caller (request-scoped for
 * owner routes → RLS enforced) AND the workspace Scope — org-scoped read/write
 * == `organization_id = current_org`; personal == owner_id + organization_id NULL.
 *
 * NOTE on imports: features/orgs/server.ts is the Phase 4 coordination hub; both
 * modules stay cycle-free (orgs/server doesn't import jobs/server — job moves are
 * implemented via table access there, not this service).
 */

const slugify = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 8) // docs/14 §3

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics; rows cast at boundary
type Client = SupabaseClient<any>

export async function createJob(
  client: Client,
  scope: Scope,
  input: CreateJobInputValue,
): Promise<JobRow> {
  // Plan gate (docs/11 §4): enforced at the service layer before the insert.
  assertWithinPlan(
    await loadPlanForScope(client, scope),
    'jobs.active',
    await countActiveJobs(client, scope),
  )

  // Unique-slug retry loop (collision odds are astronomical; cap at 3 tries).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await client
      .from('jobs')
      .insert({
        owner_id: scope.ownerId,
        organization_id: scope.kind === 'org' ? scope.orgId : null,
        title: input.title,
        description: input.description,
        slug: slugify(),
        status: 'active', // created usable immediately — docs/02 §2.3
        form_config: input.form_config,
      })
      .select('*')
      .single()
    if (!error) return data as unknown as JobRow
    if (error.code === '23505' && String(error.message).includes('slug')) continue
    throw new AppError(ErrorCode.INTERNAL, 'Could not create the job.', { cause: error })
  }
  throw new AppError(ErrorCode.CONFLICT, 'Could not allocate a hiring link. Please try again.')
}

export interface JobListItem extends JobRow {
  application_count: number
  new_count: number
}

/** docs/05 §4.1 GET /api/jobs — scoped list with per-job counts. */
export async function listJobs(
  client: Client,
  scope: Scope,
  options: { status?: JobStatusValue | undefined; limit: number; cursor?: string | undefined },
): Promise<{ data: JobListItem[]; next_cursor: string | null }> {
  let query = applyScope(client.from('jobs').select('*'), scope)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(options.limit + 1)
  if (options.status) query = query.eq('status', options.status)
  if (options.cursor) {
    const [createdAt, id] = options.cursor.split('_')
    if (createdAt && id)
      query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`)
  }
  const { data: jobs, error } = await query
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load jobs.', { cause: error })

  const page = ((jobs ?? []) as unknown as JobRow[]).slice(0, options.limit)
  const hasMore = (jobs ?? []).length > options.limit
  const last = page[page.length - 1]

  // Counts per job (Phase 1 scale: one extra select + JS reduce — docs/05 §4.1).
  const jobIds = page.map((j) => j.id)
  const counts = new Map<string, { total: number; fresh: number }>()
  if (jobIds.length > 0) {
    const { data: apps, error: appsError } = await client
      .from('applications')
      .select('job_id, status')
      .in('job_id', jobIds)
    if (appsError)
      throw new AppError(ErrorCode.INTERNAL, 'Could not load job stats.', { cause: appsError })
    for (const row of (apps ?? []) as Array<{ job_id: string; status: string }>) {
      const entry = counts.get(row.job_id) ?? { total: 0, fresh: 0 }
      entry.total += 1
      if (row.status === 'new') entry.fresh += 1
      counts.set(row.job_id, entry)
    }
  }

  return {
    data: page.map((job) => {
      const c = counts.get(job.id) ?? { total: 0, fresh: 0 }
      return { ...job, application_count: c.total, new_count: c.fresh }
    }),
    next_cursor: hasMore && last ? `${last.created_at}_${last.id}` : null,
  }
}

/** Scoped fetch — missing OR out-of-workspace ids both return null (404, docs/05 §2). */
export async function getJob(client: Client, scope: Scope, id: string): Promise<JobRow | null> {
  const { data, error } = await applyScope(client.from('jobs').select('*'), scope)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load the job.', { cause: error })
  return (data as unknown as JobRow) ?? null
}

/** docs/05 §4.1 GET /api/jobs/:id — stats aggregated by status. Job must be scope-verified first. */
export async function getJobStats(client: Client, jobId: string): Promise<Record<string, number>> {
  const { data, error } = await client.from('applications').select('status').eq('job_id', jobId)
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load job stats.', { cause: error })
  const byStatus: Record<string, number> = {}
  for (const row of (data ?? []) as Array<{ status: string }>) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
  }
  return byStatus
}

export async function updateJob(
  client: Client,
  scope: Scope,
  job: JobRow,
  input: UpdateJobInputType,
): Promise<JobRow> {
  if (input.status && !canTransitionJob(job.status, input.status)) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Jobs cannot move from "${job.status}" to "${input.status}".`,
    )
  }
  // Activation counts against the plan cap (docs/11 §4 — closed→active too).
  if (input.status === 'active' && job.status !== 'active') {
    assertWithinPlan(
      await loadPlanForScope(client, scope),
      'jobs.active',
      await countActiveJobs(client, scope),
    )
  }
  const updates: Record<string, unknown> = {}
  if (input.title !== undefined) updates.title = input.title
  if (input.description !== undefined) updates.description = input.description
  if (input.form_config !== undefined) updates.form_config = input.form_config
  if (input.status !== undefined) updates.status = input.status

  const { data, error } = await client
    .from('jobs')
    .update(updates)
    .eq('id', job.id)
    .select('*')
    .single()
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not update the job.', { cause: error })
  return data as unknown as JobRow
}

export async function deleteJob(client: Client, id: string): Promise<void> {
  // Cascades applications/resumes/timeline/notes via FK (docs/04 §8). The caller
  // scope-verified the job via getJob(scope) first (docs/11 §1).
  const { error } = await client.from('jobs').delete().eq('id', id)
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not delete the job.', { cause: error })
}

/**
 * Public apply-page config — docs/05 §4.1. Service client, explicit columns only;
 * DRAFT jobs are indistinguishable from unknown slugs (no existence leak, docs/05 §2).
 * organization_id included so the apply flow resolves org integrations/brand (docs/11 §3/§9).
 */
export async function getPublicJobBySlug(
  client: Client,
  slug: string,
): Promise<(PublicJob & { id: string; owner_id: string; organization_id: string | null }) | null> {
  const { data, error } = await client
    .from('jobs')
    .select('id, owner_id, organization_id, title, description, status, form_config')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load the job.', { cause: error })
  const job = data as unknown as
    (PublicJob & { id: string; owner_id: string; organization_id: string | null }) | null
  if (!job || job.status === 'draft') return null
  return job
}

/** Org record for public-brand/application resolution (docs/11 §9) — service-client zone only. */
export async function getOrgBrandForJob(
  client: Client,
  organizationId: string,
): Promise<{ id: string; name: string; plan: string; brand: Record<string, unknown> } | null> {
  const { data, error } = await client
    .from('organizations')
    .select('id, name, plan, brand')
    .eq('id', organizationId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the organization.', { cause: error })
  return (
    (data as unknown as {
      id: string
      name: string
      plan: string
      brand: Record<string, unknown>
    } | null) ?? null
  )
}
