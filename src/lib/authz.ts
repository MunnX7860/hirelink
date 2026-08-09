/**
 * Authorization matrix — docs/11 §2 (normative). Pure data + pure predicate:
 * no DB, no framework — the throwing enforcement lives in features/orgs/server.ts.
 *
 * Personal workspace = implicit full control (scope checks happen before authz).
 * Rules that can't live in a flat matrix (org-owner-only actions, admin-vs-owner
 * member management) are guarded in the service layer right next to the action —
 * each such site cites this table.
 */
export type MemberRole = 'owner' | 'admin' | 'member'

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'] as const

export type Capability =
  /** Jobs: create / edit / close / move between workspaces. */
  | 'jobs.write'
  /** Applications: review / move status / notes / tags / delete. */
  | 'applications.write'
  /** Integrations: connect / disconnect org integrations (members = read-only). */
  | 'integrations.manage'
  /** Org settings: rename the workspace (docs/05 §4.9 — owner/admin). */
  | 'org.rename'
  /**
   * Members: invite / change role / remove.
   * Caveat enforced in services (11 §2): org owner is untouchable; admins may manage
   * admins only for invite/promote — demoting or removing an admin requires the org owner.
   */
  | 'members.manage'
  /** Branding + plan-sensitive org edits — org OWNER only (11 §2 row). */
  | 'org.branding'
  /** Transfer ownership — org OWNER only. */
  | 'org.transfer'
  /** Delete / restore the org — org OWNER only. */
  | 'org.delete'

const CAPABILITIES: Record<MemberRole, readonly Capability[]> = {
  owner: [
    'jobs.write',
    'applications.write',
    'integrations.manage',
    'org.rename',
    'members.manage',
    'org.branding',
    'org.transfer',
    'org.delete',
  ],
  admin: [
    'jobs.write',
    'applications.write',
    'integrations.manage',
    'org.rename',
    'members.manage',
  ],
  member: ['jobs.write', 'applications.write'],
}

/** Role → capability check. Unknown/null role denies everything. */
export function can(role: MemberRole | null | undefined, capability: Capability): boolean {
  if (!role) return false
  return (CAPABILITIES[role] ?? []).includes(capability)
}

/**
 * Org-owner-only capabilities (11 §2): satisfied ONLY by holding
 * `organizations.owner_id`, not merely the `owner` role (same thing in practice,
 * but services check the row to be explicit about transfer semantics).
 */
export const ORG_OWNER_ONLY: readonly Capability[] = ['org.branding', 'org.transfer', 'org.delete']

export function isOrgOwnerOnly(capability: Capability): boolean {
  return ORG_OWNER_ONLY.includes(capability)
}
