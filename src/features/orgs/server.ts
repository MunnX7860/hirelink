import 'server-only'

import { createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import { customAlphabet } from 'nanoid'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { User } from '@supabase/supabase-js'
import { AppError, ErrorCode } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import { createClient } from '@/lib/supabase/server'
import { can, isOrgOwnerOnly, type Capability, type MemberRole } from '@/lib/authz'
import {
  isWithinPlan,
  normalizePlan,
  planLimitDetails,
  limitFor,
  canUseCustomBranding,
  type PlanId,
  type PlanLimitKey,
} from '@/lib/plans'
import { env } from '@/lib/env'
import { sendEmail } from '@/lib/notifications/email'
import { renderEmail } from '@/emails/registry'
import type { Scope } from '@/features/orgs/scope'
import { applyScope } from '@/features/orgs/scope'
import type {
  BrandValue,
  CreateOrgInputValue,
  CreateInviteInputValue,
  OrgRow,
  OrgMemberView,
  PendingInviteView,
  OrgUsageView,
  WorkspaceView,
} from '@/features/orgs/schemas'
import { OrgRowSchema, INVITE_TTL_DAYS } from '@/features/orgs/schemas'

/**
 * Organizations service — docs/11 (normative), docs/05 §4.9.
 * Runs on the request-scoped (RLS) client; the atomic invite-accept path uses the
 * security-definer RPCs from migration 0006 — the service-role client is never
 * needed here (docs/03 §Rules).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

export const WORKSPACE_COOKIE = 'hl_org'
const orgSlugify = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10) // docs/04 §3.2
const inviteToken = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  24,
)

// ── Capability enforcement (authz — docs/11 §2) ───────────────────────────────

/**
 * Throws 403 FORBIDDEN when the current scope may not perform `capability`.
 * Org-owner-only capabilities additionally require `organizations.owner_id` —
 * pass it via opts when the capability is org.branding/org.transfer/org.delete.
 */
export function assertCapability(
  scope: Scope,
  capability: Capability,
  opts?: { orgOwnerId?: string },
): void {
  if (scope.kind === 'personal') return // own workspace: full control (docs/11 §2)
  if (isOrgOwnerOnly(capability)) {
    if (opts?.orgOwnerId && scope.ownerId === opts.orgOwnerId) return
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'Only the organization owner can do that. Transfer ownership first if needed.',
    )
  }
  if (!can(scope.role, capability)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      capability === 'integrations.manage'
        ? 'Only organization owners and admins manage integrations.'
        : 'Only organization owners and admins manage members.',
    )
  }
}

/** Throws 402 PLAN_LIMIT when the next action would exceed the cap (docs/11 §4). */
export function assertWithinPlan(plan: PlanId, key: PlanLimitKey, used: number): void {
  const norm = normalizePlan(plan)
  if (isWithinPlan(norm, key, used)) return
  const what =
    key === 'jobs.active' ? 'active jobs' : key === 'seats' ? 'team seats' : 'stored applications'
  throw new AppError(
    ErrorCode.PLAN_LIMIT,
    `Your ${norm} plan covers up to ${limitFor(norm, key)} ${what}. Ask the workspace owner to upgrade to grow beyond that.`,
    { details: planLimitDetails(norm, key, used) },
  )
}

// ── Memberships & workspace resolution (docs/11 §1) ──────────────────────────

interface MembershipRow {
  role: MemberRole
  org: OrgRow | OrgRow[] | null
}

export async function getMemberships(
  client: Client,
  userId: string,
): Promise<Array<{ org: OrgRow; role: MemberRole }>> {
  const { data, error } = await client
    .from('organization_members')
    .select(
      'role, org:organizations!inner(id, name, slug, owner_id, brand, plan, created_at, deleted_at)',
    )
    .eq('user_id', userId)
    .is('organizations.deleted_at', null)
    .order('created_at', { ascending: true })
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load workspaces.', { cause: error })
  const out: Array<{ org: OrgRow; role: MemberRole }> = []
  for (const row of (data ?? []) as unknown as Array<
    MembershipRow & { org: { deleted_at?: string | null } | null }
  >) {
    const orgRaw = Array.isArray(row.org) ? row.org[0] : row.org
    if (!orgRaw) continue
    const parsed = OrgRowSchema.safeParse(orgRaw)
    if (!parsed.success) continue
    out.push({ org: parsed.data, role: row.role })
  }
  return out
}

/** Membership (role) of `userId` in `orgId` — null when not a member or org deleted. */
export async function getMembership(
  client: Client,
  userId: string,
  orgId: string,
): Promise<{ org: OrgRow; role: MemberRole } | null> {
  const memberships = await getMemberships(client, userId)
  return memberships.find((m) => m.org.id === orgId) ?? null
}

/**
 * Resolves the caller's current workspace — docs/11 §1: cookie `hl_org` →
 * users.default_organization_id → personal. Dead candidates (membership revoked,
 * org deleted) are skipped silently. Never cached.
 */
export async function resolveWorkspace(
  client: Client,
  userId: string,
  opts?: { cookieValue?: string | null },
): Promise<Scope> {
  const cookieStore = await cookies()
  const cookieOrg =
    opts?.cookieValue !== undefined ? opts.cookieValue : cookieStore.get(WORKSPACE_COOKIE)?.value

  const [memberships, { data: userRow }] = await Promise.all([
    getMemberships(client, userId),
    client.from('users').select('default_organization_id').eq('id', userId).maybeSingle(),
  ])

  const candidates: Array<string | null | undefined> = [
    cookieOrg && cookieOrg !== 'personal' ? cookieOrg : null,
    (userRow as { default_organization_id?: string | null } | null)?.default_organization_id,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const hit = memberships.find((m) => m.org.id === candidate)
    if (hit) {
      return { kind: 'org', ownerId: userId, orgId: hit.org.id, role: hit.role }
    }
  }
  return { kind: 'personal', ownerId: userId }
}

/** Shared route guard for Phase-4-scoped routes — supabase + user + workspace. */
export async function requireWorkspace(): Promise<{
  supabase: Client
  user: User
  scope: Scope
}> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new AppError(ErrorCode.UNAUTHORIZED, 'Sign in required.')
  const scope = await resolveWorkspace(supabase, user.id)
  return { supabase: supabase as Client, user, scope }
}

export async function switchWorkspace(
  client: Client,
  userId: string,
  organizationId: string | null,
): Promise<WorkspaceView> {
  const cookieStore = await cookies()
  const cookieBase = {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  }
  if (!organizationId) {
    cookieStore.set(WORKSPACE_COOKIE, 'personal', cookieBase)
    // Sticky default follows the explicit personal choice (docs/11 §1). Switching
    // is itself an explicit workspace decision, so it also satisfies the one-time
    // chooser (docs/11 §6) if it hadn't fired yet — always restamping is harmless,
    // this column is only ever read as a boolean "has chosen" signal.
    await client
      .from('users')
      .update({ default_organization_id: null, workspace_onboarded_at: new Date().toISOString() })
      .eq('id', userId)
    return { kind: 'personal' }
  }
  const membership = await getMembership(client, userId, organizationId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  cookieStore.set(WORKSPACE_COOKIE, organizationId, cookieBase)
  await client
    .from('users')
    .update({
      default_organization_id: organizationId,
      workspace_onboarded_at: new Date().toISOString(),
    })
    .eq('id', userId)
  return { kind: 'org', org: { ...membership.org, role: membership.role } }
}

/**
 * One-time workspace chooser (docs/11 §6, docs/02 §10.1): true when the user
 * has never made an explicit personal-vs-org choice AND has >=1 membership to
 * choose between. `default_organization_id IS NULL` alone can't tell "never
 * chosen" apart from "explicitly chose personal" — `workspace_onboarded_at` is
 * the dedicated signal (migration 0010).
 */
export async function needsWorkspaceChooser(client: Client, userId: string): Promise<boolean> {
  const { data } = await client
    .from('users')
    .select('workspace_onboarded_at')
    .eq('id', userId)
    .maybeSingle()
  const onboarded = Boolean(
    (data as { workspace_onboarded_at?: string | null } | null)?.workspace_onboarded_at,
  )
  if (onboarded) return false
  const memberships = await getMemberships(client, userId)
  return memberships.length > 0
}

// ── Usage counters + plan gate helpers (docs/11 §4) ──────────────────────────

export async function countActiveJobs(client: Client, scope: Scope): Promise<number> {
  const { count, error } = await applyScope(
    client.from('jobs').select('id', { count: 'exact', head: true }),
    scope,
  ).eq('status', 'active')
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not count jobs.', { cause: error })
  return count ?? 0
}

/** members + pending invites both reserve seats (docs/11 §4). */
export async function countSeatsUsed(client: Client, orgId: string): Promise<number> {
  const [{ count: members, error: e1 }, { count: pending, error: e2 }] = await Promise.all([
    client
      .from('organization_members')
      .select('user_id', { count: 'exact', head: true })
      .eq('organization_id', orgId),
    client
      .from('organization_invites')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('accepted_at', null),
  ])
  if (e1 || e2)
    throw new AppError(ErrorCode.INTERNAL, 'Could not count seats.', { cause: e1 ?? e2 })
  return (members ?? 0) + (pending ?? 0)
}

export async function countApplications(client: Client, scope: Scope): Promise<number> {
  const filters =
    scope.kind === 'org'
      ? { 'jobs.organization_id': scope.orgId }
      : { 'jobs.owner_id': scope.ownerId, 'jobs.organization_id': null }
  let q = client
    .from('applications')
    .select('id, job:jobs!inner(id)', { count: 'exact', head: true })
  for (const [column, value] of Object.entries(filters)) {
    q = value === null ? q.is(column, value) : q.eq(column, value as string)
  }
  const { count, error } = await q
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not count applications.', { cause: error })
  return count ?? 0
}

/** Plan of the given scope (personal = free forever — docs/11 §4). */
export function planForScope(scope: Scope, org?: OrgRow | null): PlanId {
  return scope.kind === 'org' ? normalizePlan(org?.plan ?? null) : 'free'
}

/** DB-backed variant used by services holding a Scope but not the org row. */
export async function loadPlanForScope(client: Client, scope: Scope): Promise<PlanId> {
  if (scope.kind !== 'org') return 'free'
  const { data, error } = await client
    .from('organizations')
    .select('plan')
    .eq('id', scope.orgId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) throw new AppError(ErrorCode.INTERNAL, 'Could not load the plan.', { cause: error })
  return normalizePlan((data as { plan?: string } | null)?.plan ?? null)
}

export async function getUsage(
  client: Client,
  scope: Scope,
  org: OrgRow | null,
): Promise<OrgUsageView> {
  const [activeJobs, applications] = await Promise.all([
    countActiveJobs(client, scope),
    countApplications(client, scope),
  ])
  const seats = scope.kind === 'org' && org ? await countSeatsUsed(client, org.id) : 1
  return { active_jobs: activeJobs, seats, applications }
}

// ── Org CRUD (docs/05 §4.9) ──────────────────────────────────────────────────

export async function createOrg(
  client: Client,
  userId: string,
  input: CreateOrgInputValue,
): Promise<{ org: OrgRow; role: 'owner' }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: orgRow, error } = await client
      .from('organizations')
      .insert({ name: input.name, slug: orgSlugify(), owner_id: userId })
      .select('id, name, slug, owner_id, brand, plan, created_at')
      .single()
    if (error) {
      if (error.code === '23505' && String(error.message).includes('slug')) continue
      throw new AppError(ErrorCode.INTERNAL, 'Could not create the organization.', {
        cause: error,
      })
    }
    const org = OrgRowSchema.parse(orgRow)
    const { error: memberError } = await client
      .from('organization_members')
      .insert({ organization_id: org.id, user_id: userId, role: 'owner' })
    if (memberError)
      throw new AppError(ErrorCode.INTERNAL, 'Could not create the organization.', {
        cause: memberError,
      })
    return { org, role: 'owner' }
  }
  throw new AppError(ErrorCode.CONFLICT, 'Could not allocate an organization slug. Try again.')
}

export async function getOrgDetail(
  client: Client,
  scope: Scope,
  orgId: string,
): Promise<{
  org: OrgRow
  role: MemberRole
  members: OrgMemberView[]
  pending_invites: PendingInviteView[]
  usage: OrgUsageView
  limits: Record<PlanLimitKey, number>
}> {
  // Membership resolves against the CALLER (scope.ownerId) — org or not, detail is
  // member-only with 404 semantics (docs/05 §4.9).
  const membership = await getMembership(client, scope.ownerId, orgId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  const { org, role } = membership
  const orgScope: Scope = { kind: 'org', ownerId: scope.ownerId, orgId: org.id, role }

  const { data: memberRows, error: membersError } = await client
    .from('organization_members')
    .select('user_id, role, created_at, user:users(full_name, email)')
    .eq('organization_id', org.id)
    .order('created_at', { ascending: true })
  if (membersError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load members.', { cause: membersError })
  const members: OrgMemberView[] = (
    (memberRows ?? []) as unknown as Array<{
      user_id: string
      role: MemberRole
      created_at: string
      user:
        | { full_name: string | null; email: string }
        | Array<{ full_name: string | null; email: string }>
        | null
    }>
  ).map((m) => {
    const u = Array.isArray(m.user) ? m.user[0] : m.user
    return {
      user_id: m.user_id,
      full_name: u?.full_name ?? null,
      email: u?.email ?? '',
      role: m.role,
      created_at: m.created_at,
    }
  })

  let pending: PendingInviteView[] = []
  // members.manage viewers get pending invites (docs/05 §4.9); others an empty list.
  try {
    assertCapability(orgScope, 'members.manage')
    const { data: inviteRows, error: invitesError } = await client
      .from('organization_invites')
      .select('id, email, role, expires_at, created_at')
      .eq('organization_id', org.id)
      .is('accepted_at', null)
      .order('created_at', { ascending: false })
    if (invitesError) throw invitesError
    pending = (inviteRows ?? []) as unknown as PendingInviteView[]
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'FORBIDDEN')) throw err
  }

  const plan = normalizePlan(org.plan)
  const usage = await getUsage(client, orgScope, org)
  const limits: Record<PlanLimitKey, number> = {
    'jobs.active': limitFor(plan, 'jobs.active'),
    seats: limitFor(plan, 'seats'),
    'applications.stored': limitFor(plan, 'applications.stored'),
  }
  return { org, role, members, pending_invites: pending, usage, limits }
}

export async function updateOrg(
  client: Client,
  scope: Scope,
  orgId: string,
  input: { name?: string | undefined; brand?: BrandValue | undefined },
): Promise<OrgRow> {
  const membership = await getMembership(client, scope.ownerId, orgId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  const { org } = membership
  const orgScope: Scope = {
    kind: 'org',
    ownerId: scope.ownerId,
    orgId: org.id,
    role: membership.role,
  }

  const updates: Record<string, unknown> = {}
  if (input.name !== undefined) {
    assertCapability(orgScope, 'org.rename') // docs/05 §4.9 — owner/admin
    updates.name = input.name
  }
  if (input.brand !== undefined) {
    // Branding = org owner only + plan-gated (docs/11 §2/§4).
    assertCapability(orgScope, 'org.branding', { orgOwnerId: org.owner_id })
    const plan = normalizePlan(org.plan)
    const wantsCustom = Boolean(
      input.brand.logo_url || input.brand.primary_color || input.brand.email_from_name,
    )
    if (wantsCustom && plan === 'free') {
      throw new AppError(
        ErrorCode.PLAN_LIMIT,
        'Custom branding is available on Pro and Team workspaces. Upgrade to make it yours.',
        { details: { ...planLimitDetails(plan, 'jobs.active', 0), upgrade: 'pro' } },
      )
    }
    updates.brand = input.brand
  }

  const { data, error } = await client
    .from('organizations')
    .update(updates)
    .eq('id', org.id)
    .select('id, name, slug, owner_id, brand, plan, created_at')
    .maybeSingle()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not update the organization.', { cause: error })
  if (!data) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  return OrgRowSchema.parse(data)
}

export async function deleteOrg(client: Client, scope: Scope, orgId: string): Promise<void> {
  const membership = await getMembership(client, scope.ownerId, orgId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  assertCapability(
    { kind: 'org', ownerId: scope.ownerId, orgId, role: membership.role },
    'org.delete',
    { orgOwnerId: membership.org.owner_id },
  )
  const { error } = await client
    .from('organizations')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', orgId)
    .is('deleted_at', null)
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not delete the organization.', { cause: error })
  // The deleter's own default may point at the dead org — reset it (defense in depth;
  // other members' stale defaults are skipped naturally at resolution, docs/11 §1).
  await client
    .from('users')
    .update({ default_organization_id: null })
    .eq('id', scope.ownerId)
    .eq('default_organization_id', orgId)
}

export async function restoreOrg(client: Client, scope: Scope, orgId: string): Promise<OrgRow> {
  // Restore must bypass getMembership (deleted orgs vanish from resolution) — owner check only.
  const { data: ownerRow, error: loadError } = await client
    .from('organizations')
    .select('id, name, slug, owner_id, brand, plan, created_at, deleted_at')
    .eq('id', orgId)
    .maybeSingle()
  if (loadError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the organization.', { cause: loadError })
  const row = ownerRow as (OrgRow & { deleted_at?: string | null }) | null
  if (!row || row.owner_id !== scope.ownerId || !row.deleted_at) {
    throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  }
  const { data, error } = await client
    .from('organizations')
    .update({ deleted_at: null })
    .eq('id', orgId)
    .select('id, name, slug, owner_id, brand, plan, created_at')
    .single()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not restore the organization.', { cause: error })
  return OrgRowSchema.parse(data)
}

export async function transferOrg(
  client: Client,
  scope: Scope,
  orgId: string,
  targetUserId: string,
): Promise<void> {
  const membership = await getMembership(client, scope.ownerId, orgId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  assertCapability(
    { kind: 'org', ownerId: scope.ownerId, orgId, role: membership.role },
    'org.transfer',
    { orgOwnerId: membership.org.owner_id },
  )
  if (targetUserId === scope.ownerId) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'You already own this organization.')
  }
  const { data: target, error: targetError } = await client
    .from('organization_members')
    .select('user_id')
    .eq('organization_id', orgId)
    .eq('user_id', targetUserId)
    .maybeSingle()
  if (targetError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load members.', { cause: targetError })
  if (!target)
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'Ownership can only transfer to a member.')

  // Order matters; each statement is verified (docs/11 §2 transfer semantics).
  const { error: orgError } = await client
    .from('organizations')
    .update({ owner_id: targetUserId })
    .eq('id', orgId)
  if (orgError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not transfer ownership.', { cause: orgError })
  const { error: promoteError } = await client
    .from('organization_members')
    .update({ role: 'owner' })
    .eq('organization_id', orgId)
    .eq('user_id', targetUserId)
  const { error: demoteError } = await client
    .from('organization_members')
    .update({ role: 'admin' })
    .eq('organization_id', orgId)
    .eq('user_id', scope.ownerId)
  if (promoteError || demoteError) {
    logger.error('org transfer role swap incomplete', {
      org_id: orgId,
      ...errorSummary(promoteError ?? demoteError),
    })
    throw new AppError(
      ErrorCode.INTERNAL,
      'Ownership row updated but roles need attention — contact support.',
    )
  }
}

// ── Members (docs/05 §4.9, 11 §2) ────────────────────────────────────────────

export async function updateMemberRole(
  client: Client,
  scope: Scope,
  orgId: string,
  targetUserId: string,
  role: 'admin' | 'member',
): Promise<void> {
  const membership = await getMembership(client, scope.ownerId, orgId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  const orgScope: Scope = { kind: 'org', ownerId: scope.ownerId, orgId, role: membership.role }
  assertCapability(orgScope, 'members.manage')

  const { data: targetRow, error: targetError } = await client
    .from('organization_members')
    .select('role')
    .eq('organization_id', orgId)
    .eq('user_id', targetUserId)
    .maybeSingle()
  if (targetError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the member.', { cause: targetError })
  if (!targetRow) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found.')
  const targetRole = (targetRow as { role: MemberRole }).role

  // docs/11 §2 caveat: the org owner is untouchable; demoting an admin needs the
  // org owner's own authority, a plain admin can't do it.
  if (targetUserId === membership.org.owner_id) {
    throw new AppError(ErrorCode.FORBIDDEN, 'The organization owner cannot be changed here.')
  }
  if (targetRole === 'admin' && role === 'member' && scope.ownerId !== membership.org.owner_id) {
    throw new AppError(ErrorCode.FORBIDDEN, 'Only the organization owner can demote an admin.')
  }

  const { error } = await client
    .from('organization_members')
    .update({ role })
    .eq('organization_id', orgId)
    .eq('user_id', targetUserId)
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not update the member.', { cause: error })
}

export async function removeMember(
  client: Client,
  scope: Scope,
  orgId: string,
  targetUserId: string,
): Promise<void> {
  const membership = await getMembership(client, scope.ownerId, orgId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  const self = targetUserId === scope.ownerId
  if (!self) {
    const orgScope: Scope = { kind: 'org', ownerId: scope.ownerId, orgId, role: membership.role }
    assertCapability(orgScope, 'members.manage')
  }
  // docs/11 §2: the org owner can never be removed (self-leave included).
  if (targetUserId === membership.org.owner_id) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      'The organization owner must transfer ownership before leaving.',
    )
  }

  const { data, error } = await client
    .from('organization_members')
    .delete()
    .eq('organization_id', orgId)
    .eq('user_id', targetUserId)
    .select('user_id')
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not remove the member.', { cause: error })
  if (!data || data.length === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found.')

  // Reset the removed member's sticky default (docs/05 §4.9). Best-effort: failures
  // self-heal at workspace resolution (dead defaults are skipped, docs/11 §1).
  const { error: resetError } = await client
    .from('users')
    .update({ default_organization_id: null })
    .eq('id', targetUserId)
    .eq('default_organization_id', orgId)
  if (resetError) {
    logger.warn('default-org reset after member removal failed (self-heals)', {
      org_id: orgId,
      ...errorSummary(resetError),
    })
  }
}

// ── Invites (docs/05 §4.9, 11 §7) ────────────────────────────────────────────

/** sha256 hex — invite tokens are stored hashed (raw token lives only in the URL). Exported for tests. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createInvite(
  client: Client,
  scope: Scope,
  orgId: string,
  input: CreateInviteInputValue,
): Promise<{ invite: PendingInviteView; join_url: string }> {
  const membership = await getMembership(client, scope.ownerId, orgId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  const { org } = membership
  const orgScope: Scope = { kind: 'org', ownerId: scope.ownerId, orgId, role: membership.role }
  assertCapability(orgScope, 'members.manage')

  // Seats cap: members + pending invites reserve seats (docs/11 §4).
  const plan = normalizePlan(org.plan)
  const used = await countSeatsUsed(client, org.id)
  assertWithinPlan(plan, 'seats', used)

  // Best-effort "already a member?" guard (full certainty arrives at accept time:
  // accept_org_invite is idempotent per user — docs/05 §4.9).
  const email = input.email.trim().toLowerCase()
  const { data: userCandidates } = await client.from('users').select('id').eq('email', email)
  const candidate = (userCandidates ?? [])[0] as { id: string } | undefined
  if (candidate) {
    const { data: existing } = await client
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', org.id)
      .eq('user_id', candidate.id)
    if (existing && existing.length > 0) {
      throw new AppError(ErrorCode.ALREADY_MEMBER, 'That person is already in this workspace.')
    }
  }

  // Re-inviting the same email replaces the pending invite (fresh link, docs/05 §4.9).
  await client
    .from('organization_invites')
    .delete()
    .eq('organization_id', org.id)
    .eq('email', email)
    .is('accepted_at', null)

  const token = inviteToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await client
    .from('organization_invites')
    .insert({
      organization_id: org.id,
      email,
      role: input.role,
      token_hash: hashToken(token),
      invited_by: scope.ownerId,
      expires_at: expiresAt,
    })
    .select('id, email, role, expires_at, created_at')
    .single()
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not create the invite.', { cause: error })

  const joinUrl = `${env.NEXT_PUBLIC_APP_URL}/invite/${token}`
  try {
    const { data: inviter } = await client
      .from('users')
      .select('full_name, email')
      .eq('id', scope.ownerId)
      .maybeSingle()
    const inviterName =
      (inviter as { full_name?: string | null; email?: string } | null)?.full_name ??
      (inviter as { email?: string } | null)?.email ??
      'A teammate'
    await sendInviteEmail({ to: email, orgName: org.name, role: input.role, joinUrl, inviterName })
  } catch (err) {
    // Invite email is best-effort (03 §6): the join URL is returned for manual sharing.
    logger.warn('invite email failed (join_url still returned)', {
      org_id: org.id,
      ...errorSummary(err),
    })
  }
  return { invite: data as unknown as PendingInviteView, join_url: joinUrl }
}

export async function revokeInvite(
  client: Client,
  scope: Scope,
  orgId: string,
  inviteId: string,
): Promise<void> {
  const membership = await getMembership(client, scope.ownerId, orgId)
  if (!membership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
  assertCapability(
    { kind: 'org', ownerId: scope.ownerId, orgId, role: membership.role },
    'members.manage',
  )
  const { data, error } = await client
    .from('organization_invites')
    .delete()
    .eq('id', inviteId)
    .eq('organization_id', orgId)
    .is('accepted_at', null)
    .select('id')
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not revoke the invite.', { cause: error })
  if (!data || data.length === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Invite not found.')
}

interface RpcErrorLike {
  message?: string
  code?: string
  details?: string
}

function mapInviteRpcError(error: RpcErrorLike): AppError {
  const blob = `${error.code ?? ''} ${error.message ?? ''} ${error.details ?? ''}`
  if (blob.includes('P0001') || blob.includes('email_mismatch')) {
    return new AppError(
      ErrorCode.FORBIDDEN,
      'This invite was sent to a different email address. Sign in with the invited account to accept it.',
    )
  }
  if (blob.includes('P0003') || blob.includes('seats_exceeded')) {
    return new AppError(ErrorCode.PLAN_LIMIT, 'This workspace is out of seats on its plan.', {
      details: { limit_key: 'seats' },
    })
  }
  return new AppError(
    ErrorCode.INVITE_EXPIRED,
    'This invite link is invalid or has expired. Ask for a fresh one.',
  )
}

export interface InvitePeek {
  org_name: string
  role: MemberRole
  inviter_name: string | null
  email: string
  expires_at: string
}

export async function lookupInvite(client: Client, token: string): Promise<InvitePeek> {
  const { data, error } = await client.rpc('lookup_invite', { p_token: token })
  if (error) throw mapInviteRpcError(error as RpcErrorLike)
  const rows = (data ?? []) as Array<InvitePeek>
  const row = rows[0]
  if (!row) throw mapInviteRpcError({ code: 'P0002' })
  return row
}

export async function acceptInvite(
  client: Client,
  scope: Scope,
  token: string,
): Promise<{ org_id: string; org_name: string; role: MemberRole; already_member: boolean }> {
  // The RPC does everything atomically (docs/05 §4.9, migration 0006): token validity,
  // session-email match, seat cap (plan→cap mirrored in SQL), idempotent membership.
  // `scope` is accepted for call-site symmetry with other org routes (auth proven upstream).
  void scope
  const { data, error } = await client.rpc('accept_org_invite', { p_token: token })
  if (error) throw mapInviteRpcError(error as RpcErrorLike)
  const rows = (data ?? []) as Array<{
    org_id: string
    org_name: string
    role: MemberRole
    already_member: boolean
  }>
  const row = rows[0]
  if (!row) throw mapInviteRpcError({ code: 'P0002' })
  return row
}

// ── Job move (docs/05 §4.1, 11 §2/§6.2) ──────────────────────────────────────

export async function moveJob(
  client: Client,
  scope: Scope,
  userId: string,
  jobId: string,
  targetOrganizationId: string | null,
): Promise<{ id: string; organization_id: string | null }> {
  const { data: jobRow, error: jobError } = await client
    .from('jobs')
    .select('id, owner_id, organization_id, status')
    .eq('id', jobId)
    .maybeSingle()
  if (jobError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load the job.', { cause: jobError })
  const job = jobRow as {
    id: string
    owner_id: string
    organization_id: string | null
    status: string
  } | null
  if (!job) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')

  // Current-scope containment == 404 semantics for out-of-scope ids (docs/11 §1).
  const inCurrentScope =
    scope.kind === 'org' ? job.organization_id === scope.orgId : job.organization_id === null
  if (!inCurrentScope) throw new AppError(ErrorCode.NOT_FOUND, 'Job not found.')

  // Source permission (docs/11 §2): creator, or owner/admin of the source org.
  const isCreator = job.owner_id === userId
  let sourceRole: MemberRole | null = null
  if (!isCreator && job.organization_id) {
    const m = await getMembership(client, userId, job.organization_id)
    sourceRole = m?.role ?? null
    if (sourceRole !== 'owner' && sourceRole !== 'admin') {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Only the job creator or an organization admin can move this job.',
      )
    }
  } else if (!isCreator) {
    throw new AppError(ErrorCode.FORBIDDEN, 'Only the job creator can move this job.')
  }

  // Target permission + plan gate.
  if (targetOrganizationId === null) {
    if (!isCreator) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Only the job creator can move a job into their personal workspace.',
      )
    }
  } else {
    const targetMembership = await getMembership(client, userId, targetOrganizationId)
    if (!targetMembership) throw new AppError(ErrorCode.NOT_FOUND, 'Organization not found.')
    if (job.organization_id === targetOrganizationId) {
      return { id: job.id, organization_id: job.organization_id } // idempotent no-op
    }
    if (job.status === 'active') {
      const targetScope: Scope = {
        kind: 'org',
        ownerId: userId,
        orgId: targetOrganizationId,
        role: targetMembership.role,
      }
      assertWithinPlan(
        normalizePlan(targetMembership.org.plan),
        'jobs.active',
        await countActiveJobs(client, targetScope),
      )
    }
  }

  const { error: moveError } = await client
    .from('jobs')
    .update({ organization_id: targetOrganizationId })
    .eq('id', job.id)
  if (moveError)
    throw new AppError(ErrorCode.INTERNAL, 'Could not move the job.', { cause: moveError })

  // docs/11 §6.2: re-scope applicants whose applications ALL live inside the target scope.
  await rescopeExclusivelyAttachedApplicants(client, job.id, targetOrganizationId)
  return { id: job.id, organization_id: targetOrganizationId }
}

async function rescopeExclusivelyAttachedApplicants(
  client: Client,
  jobId: string,
  targetOrganizationId: string | null,
): Promise<void> {
  const { data: attached, error: attachedError } = await client
    .from('applications')
    .select('applicant_id')
    .eq('job_id', jobId)
  if (attachedError) {
    logger.warn('job move: applicant fetch failed (job moved anyway)', {
      job_id: jobId,
      ...errorSummary(attachedError),
    })
    return
  }
  const applicantIds = [
    ...new Set(((attached ?? []) as Array<{ applicant_id: string }>).map((r) => r.applicant_id)),
  ]
  if (applicantIds.length === 0) return

  const { data: theirApps, error: appsError } = await client
    .from('applications')
    .select('applicant_id, job:jobs!inner(organization_id)')
    .in('applicant_id', applicantIds)
  if (appsError) {
    logger.warn('job move: applicant scope scan failed (job moved anyway)', {
      job_id: jobId,
      ...errorSummary(appsError),
    })
    return
  }
  const exclusive = new Set(applicantIds)
  for (const row of (theirApps ?? []) as Array<{
    applicant_id: string
    job: { organization_id: string | null } | Array<{ organization_id: string | null }> | null
  }>) {
    const org = Array.isArray(row.job) ? row.job[0]?.organization_id : row.job?.organization_id
    if ((org ?? null) !== targetOrganizationId) exclusive.delete(row.applicant_id)
  }
  const ids = [...exclusive]
  if (ids.length === 0) return
  const { error: updateError } = await client
    .from('applicants')
    .update({ organization_id: targetOrganizationId })
    .in('id', ids)
  if (updateError) {
    logger.warn('job move: applicant re-scope failed (job moved anyway)', {
      job_id: jobId,
      ...errorSummary(updateError),
    })
  }
}

// ── Purge cron (docs/11 §7) ──────────────────────────────────────────────────

export const ORG_DELETE_GRACE_DAYS = 7 as const

/**
 * Hard-delete orgs past the soft-delete grace window. Runs on the SERVICE client
 * (cron zone — docs/14 §5) with explicit org-id scoping in code. Data rows are
 * re-homed to their creators' personal workspaces — never destroyed (docs/11 §7).
 */
export async function purgeDeletedOrgs(
  client: Client,
  graceDays = ORG_DELETE_GRACE_DAYS,
): Promise<{ orgs_purged: number; rows_rehomed: number }> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000).toISOString()
  const { data: expired, error } = await client
    .from('organizations')
    .select('id')
    .not('deleted_at', 'is', null)
    .lt('deleted_at', cutoff)
  if (error)
    throw new AppError(ErrorCode.INTERNAL, 'Could not load expired organizations.', {
      cause: error,
    })
  const orgIds = ((expired ?? []) as Array<{ id: string }>).map((r) => r.id)

  let rowsRehomed = 0
  for (const orgId of orgIds) {
    let rehomeFailed = false
    for (const table of ['jobs', 'applicants', 'tags', 'integrations'] as const) {
      const { data: rehomed, error: rehomeError } = await client
        .from(table)
        .update({ organization_id: null })
        .eq('organization_id', orgId)
        .select('id')
      if (rehomeError) {
        logger.error('org purge: re-home failed — org retained for next run', {
          org_id: orgId,
          table,
          ...errorSummary(rehomeError),
        })
        rehomeFailed = true
        break
      }
      rowsRehomed += (rehomed ?? []).length
    }
    if (rehomeFailed) continue
    const { error: deleteError } = await client
      .from('organizations')
      .delete()
      .eq('id', orgId)
      .not('deleted_at', 'is', null) // never purge a restored org
    if (deleteError) {
      logger.error('org purge: org delete failed', { org_id: orgId, ...errorSummary(deleteError) })
    }
  }
  return { orgs_purged: orgIds.length, rows_rehomed: rowsRehomed }
}

// ── Invite email (best-effort — docs/05 §4.9, 03 §6) ─────────────────────────

export async function sendInviteEmail(args: {
  to: string
  orgName: string
  role: MemberRole
  joinUrl: string
  inviterName: string
}): Promise<void> {
  const rendered = await renderEmail('org_invite', {
    orgName: args.orgName,
    inviterName: args.inviterName,
    role: args.role,
    joinUrl: args.joinUrl,
  })
  const result = await sendEmail({
    to: args.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    fromName: args.orgName,
    template: 'org_invite',
  })
  if (!result.ok) throw new Error(`invite email transport failed: ${result.code}`)
}

/** Brand resolution for the public apply page + emails (docs/11 §9). Pure by design. */
export function resolveBrand(org: { name: string; plan: string; brand?: BrandValue | null }): {
  companyLabel: string
  custom: boolean
  logoUrl: string | null
  primaryColor: string | null
} {
  const custom = canUseCustomBranding(normalizePlan(org.plan))
  const brand = org.brand ?? {}
  return {
    companyLabel: brand.email_from_name ?? org.name,
    custom,
    logoUrl: custom ? (brand.logo_url ?? null) : null,
    primaryColor: custom ? (brand.primary_color ?? null) : null,
  }
}
