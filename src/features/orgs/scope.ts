import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MemberRole } from '@/lib/authz'

/**
 * Workspace scope primitives — docs/11 §1 (query rule; normative).
 *
 * Every service function operating on owned tables receives a Scope and applies it:
 *   personal → owner_id = uid AND organization_id IS NULL
 *   org      → organization_id = :org (any member; role carried for authz)
 * Detail-endpoint scope mismatches are 404 (no existence leak, docs/05 §2).
 */

export type PersonalScope = { kind: 'personal'; ownerId: string }
export type OrgScope = { kind: 'org'; ownerId: string; orgId: string; role: MemberRole }
export type Scope = PersonalScope | OrgScope

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

/**
 * Applies the scope filter to a PostgREST query on a table carrying BOTH
 * `owner_id` and `organization_id` (jobs, applicants, tags, integrations).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js builders are heavily generic; the filter call shape is what matters here
export function applyScope<Q extends { eq: any; is: any }>(query: Q, scope: Scope): Q {
  return scope.kind === 'org'
    ? query.eq('organization_id', scope.orgId)
    : query.eq('owner_id', scope.ownerId).is('organization_id', null)
}

/** JS-side scope verification for rows fetched by id (detail endpoints). */
export function isRowInScope(
  row: { owner_id?: string | null; organization_id?: string | null },
  scope: Scope,
): boolean {
  if (scope.kind === 'org') return row.organization_id === scope.orgId
  const orgIsNull = row.organization_id === null || row.organization_id === undefined
  const ownerOk = row.owner_id === undefined || row.owner_id === scope.ownerId
  return orgIsNull && ownerOk
}

/**
 * Same filter expressed as PostgREST filters on an EMBEDDED `jobs` resource —
 * for child tables (applications, resumes): `.select('*, job:jobs!inner(...)')`
 * + these filters gives exact workspace scoping without giant `.in()` id lists.
 */
export function jobEmbedFilters(
  scope: Scope,
  embedName = 'jobs',
): Array<{ column: string; op: 'eq' | 'is'; value: string }> {
  return scope.kind === 'org'
    ? [{ column: `${embedName}.organization_id`, op: 'eq', value: scope.orgId }]
    : [
        { column: `${embedName}.owner_id`, op: 'eq', value: scope.ownerId },
        { column: `${embedName}.organization_id`, op: 'is', value: 'null' },
      ]
}

/** Same for an embedded `applicants` resource (timeline dual-query). */
export function applicantEmbedFilters(
  scope: Scope,
  embedName = 'applicants',
): Array<{ column: string; op: 'eq' | 'is'; value: string }> {
  return scope.kind === 'org'
    ? [{ column: `${embedName}.organization_id`, op: 'eq', value: scope.orgId }]
    : [
        { column: `${embedName}.owner_id`, op: 'eq', value: scope.ownerId },
        { column: `${embedName}.organization_id`, op: 'is', value: 'null' },
      ]
}

/** Applies embed filters produced by jobEmbedFilters/applicantEmbedFilters. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withFilters<Q extends Record<string, any>>(
  query: Q,
  filters: Array<{ column: string; op: 'eq' | 'is'; value: string }>,
): Q {
  let q = query
  for (const f of filters) q = f.op === 'eq' ? q.eq(f.column, f.value) : q.is(f.column, f.value)
  return q
}

/** Integration resolution ref for a scope (docs/11 §3 precedence: org > personal). */
export function refForScope(scope: Scope): { ownerId: string; orgId: string | null } {
  return { ownerId: scope.ownerId, orgId: scope.kind === 'org' ? scope.orgId : null }
}

/**
 * Batch scope-validation for application ids (bulk ops): returns the subset of
 * `ids` whose parent job sits inside `scope`. One query with an inner job embed.
 */
export async function filterApplicationIdsInScope(
  client: Client,
  scope: Scope,
  ids: string[],
): Promise<Set<string>> {
  const allowed = new Set<string>()
  if (ids.length === 0) return allowed
  const { data, error } = await withFilters(
    client.from('applications').select('id, job:jobs!inner(id)').in('id', ids),
    jobEmbedFilters(scope),
  )
  if (error) throw error
  for (const row of (data ?? []) as Array<{ id: string }>) allowed.add(row.id)
  return allowed
}
