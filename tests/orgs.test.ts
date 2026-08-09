import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  PLAN_LIMITS,
  PLAN_PRICES,
  limitFor,
  normalizePlan,
  isWithinPlan,
  canUseCustomBranding,
} from '@/lib/plans'
import { AppError, ErrorCode } from '@/lib/errors'
import {
  assertWithinPlan,
  assertCapability,
  resolveBrand,
  hashToken,
  WORKSPACE_COOKIE,
  ORG_DELETE_GRACE_DAYS,
} from '@/features/orgs/server'
import { isRowInScope, refForScope, type Scope } from '@/features/orgs/scope'
import {
  BrandSchema,
  OrgRowSchema,
  CreateOrgInput,
  CreateInviteInput,
  SwitchWorkspaceInput,
  MoveJobInput,
  INVITE_TTL_DAYS,
} from '@/features/orgs/schemas'

/**
 * Phase 4 orgs unit suite — docs/13 §Phase-4: plan limits, branding gating,
 * scope primitives, schemas, and migration-0006 SQL sanity.
 */

describe('PLAN_LIMITS (docs/11 §4 — normative numbers)', () => {
  it('free: 3 active jobs / 1 seat / 500 applications, no branding', () => {
    expect(PLAN_LIMITS.free).toEqual({
      jobsActive: 3,
      seats: 1,
      applicationsStored: 500,
      customBranding: false,
    })
  })

  it('pro: 25 / 3 / 10k, branding on', () => {
    expect(PLAN_LIMITS.pro).toEqual({
      jobsActive: 25,
      seats: 3,
      applicationsStored: 10_000,
      customBranding: true,
    })
  })

  it('team: 100 / 25 / 50k, branding on', () => {
    expect(PLAN_LIMITS.team).toEqual({
      jobsActive: 100,
      seats: 25,
      applicationsStored: 50_000,
      customBranding: true,
    })
  })

  it('prices are documented for the manual-billing era', () => {
    expect(PLAN_PRICES).toEqual({ free: '$0', pro: '$12/mo', team: '$39/mo' })
  })

  it('limitFor resolves via the key map', () => {
    expect(limitFor('free', 'jobs.active')).toBe(3)
    expect(limitFor('pro', 'seats')).toBe(3)
    expect(limitFor('team', 'applications.stored')).toBe(50_000)
  })
})

describe('normalizePlan', () => {
  it('degrades unknown/null plans to free (never over-grant)', () => {
    expect(normalizePlan(null)).toBe('free')
    expect(normalizePlan(undefined)).toBe('free')
    expect(normalizePlan('enterprise')).toBe('free')
    expect(normalizePlan('pro')).toBe('pro')
    expect(normalizePlan('team')).toBe('team')
  })
})

describe('isWithinPlan (action succeeds when used < limit)', () => {
  it.each([
    ['free', 'jobs.active', 0, true],
    ['free', 'jobs.active', 2, true],
    ['free', 'jobs.active', 3, false], // 4th active job blocked (docs/13 X-suite)
    ['pro', 'seats', 2, true],
    ['pro', 'seats', 3, false],
    ['team', 'applications.stored', 49_999, true],
    ['team', 'applications.stored', 50_000, false],
  ] as const)('%s %s used=%d → %s', (plan, key, used, expected) => {
    expect(isWithinPlan(plan, key, used)).toBe(expected)
  })
})

describe('assertWithinPlan — 402 PLAN_LIMIT envelope (docs/05 §2)', () => {
  it('passes under the cap', () => {
    expect(() => assertWithinPlan('free', 'jobs.active', 2)).not.toThrow()
  })

  it('throws PLAN_LIMIT with structured details at the cap', () => {
    try {
      assertWithinPlan('free', 'jobs.active', 3)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      const appErr = err as AppError
      expect(appErr.code).toBe(ErrorCode.PLAN_LIMIT)
      expect(appErr.message).toContain('free plan')
      expect(appErr.message).toContain('3 active jobs')
      expect(appErr.details).toEqual({
        limit_key: 'jobs.active',
        used: 3,
        limit: 3,
        plan: 'free',
      })
    }
  })

  it('seats copy mentions team seats', () => {
    expect(() => assertWithinPlan('pro', 'seats', 3)).toThrowError(/3 team seats/)
  })

  it('unknown plan degrades to free caps', () => {
    expect(() => assertWithinPlan('weird' as never, 'jobs.active', 3)).toThrowError(/free plan/)
  })
})

describe('canUseCustomBranding (docs/11 §5)', () => {
  it('free cannot, pro/team can', () => {
    expect(canUseCustomBranding('free')).toBe(false)
    expect(canUseCustomBranding('pro')).toBe(true)
    expect(canUseCustomBranding('team')).toBe(true)
  })
})

describe('resolveBrand (docs/11 §5 — custom only when the plan allows)', () => {
  const brand = {
    logo_url: 'https://cdn.example.com/logo.png',
    primary_color: '#4f46e5',
    email_from_name: 'Acme Hiring',
  }

  it('pro org: full custom branding', () => {
    expect(resolveBrand({ name: 'Acme', plan: 'pro', brand })).toEqual({
      companyLabel: 'Acme Hiring',
      custom: true,
      logoUrl: 'https://cdn.example.com/logo.png',
      primaryColor: '#4f46e5',
    })
  })

  it('free org: brand suppressed → "via HireLink" badge path', () => {
    expect(resolveBrand({ name: 'Acme', plan: 'free', brand })).toEqual({
      companyLabel: 'Acme Hiring', // from-name still applies to emails (docs/11 §9)
      custom: false,
      logoUrl: null,
      primaryColor: null,
    })
  })

  it('falls back to the org name when no from-name is set', () => {
    const resolved = resolveBrand({ name: 'Acme', plan: 'team', brand: {} })
    expect(resolved.companyLabel).toBe('Acme')
    expect(resolved.custom).toBe(true)
    expect(resolved.logoUrl).toBeNull()
  })

  it('tolerates null brand', () => {
    expect(resolveBrand({ name: 'Acme', plan: 'free', brand: null }).custom).toBe(false)
  })
})

describe('assertCapability (docs/11 §2)', () => {
  const org = (role: 'owner' | 'admin' | 'member'): Scope => ({
    kind: 'org',
    ownerId: 'user-1',
    orgId: 'org-1',
    role,
  })

  it('personal scope is full control', () => {
    expect(() =>
      assertCapability({ kind: 'personal', ownerId: 'user-1' }, 'org.delete'),
    ).not.toThrow()
  })

  it('member: day-to-day ok, admin actions 403', () => {
    expect(() => assertCapability(org('member'), 'jobs.write')).not.toThrow()
    expect(() => assertCapability(org('member'), 'integrations.manage')).toThrowError(
      /owners and admins manage integrations/,
    )
    expect(() => assertCapability(org('member'), 'members.manage')).toThrowError(
      /owners and admins manage members/,
    )
  })

  it('admin: integrations.manage ok, but org-delete is owner-only', () => {
    expect(() => assertCapability(org('admin'), 'integrations.manage')).not.toThrow()
    expect(() =>
      assertCapability(org('admin'), 'org.delete', { orgOwnerId: 'someone-else' }),
    ).toThrowError(/organization owner/)
  })

  it('org-owner-only passes only when caller IS organizations.owner_id', () => {
    expect(() =>
      assertCapability(org('admin'), 'org.transfer', { orgOwnerId: 'user-1' }),
    ).not.toThrow()
    expect(() =>
      assertCapability(org('owner'), 'org.branding', { orgOwnerId: 'someone-else' }),
    ).toThrowError(/organization owner/)
  })
})

describe('scope primitives (docs/11 §1 query rule)', () => {
  const me = 'user-1'

  it('isRowInScope — org scope matches organization_id only', () => {
    const scope: Scope = { kind: 'org', ownerId: me, orgId: 'org-9', role: 'member' }
    expect(isRowInScope({ organization_id: 'org-9' }, scope)).toBe(true)
    expect(isRowInScope({ organization_id: 'org-other', owner_id: me }, scope)).toBe(false)
    expect(isRowInScope({ organization_id: null, owner_id: me }, scope)).toBe(false)
  })

  it('isRowInScope — personal scope requires own owner + NULL org', () => {
    const scope: Scope = { kind: 'personal', ownerId: me }
    expect(isRowInScope({ organization_id: null, owner_id: me }, scope)).toBe(true)
    expect(isRowInScope({ owner_id: me }, scope)).toBe(true) // undefined org treated as NULL
    expect(isRowInScope({ organization_id: 'org-9', owner_id: me }, scope)).toBe(false)
    expect(isRowInScope({ organization_id: null, owner_id: 'someone-else' }, scope)).toBe(false)
  })

  it('refForScope maps to an IntegrationRef', () => {
    expect(refForScope({ kind: 'personal', ownerId: me })).toEqual({ ownerId: me, orgId: null })
    expect(refForScope({ kind: 'org', ownerId: me, orgId: 'org-9', role: 'admin' })).toEqual({
      ownerId: me,
      orgId: 'org-9',
    })
  })
})

describe('org schemas (docs/05 §4.9)', () => {
  it('WORKSPACE_COOKIE + INVITE_TTL_DAYS + grace window match docs/11', () => {
    expect(WORKSPACE_COOKIE).toBe('hl_org')
    expect(INVITE_TTL_DAYS).toBe(7)
    expect(ORG_DELETE_GRACE_DAYS).toBe(7)
  })

  it('BrandSchema enforces hex colors + url logos (strict)', () => {
    expect(BrandSchema.safeParse({ primary_color: '#4f46e5' }).success).toBe(true)
    expect(BrandSchema.safeParse({ primary_color: 'indigo' }).success).toBe(false)
    expect(BrandSchema.safeParse({ primary_color: '#fff' }).success).toBe(false) // 6 digits
    expect(BrandSchema.safeParse({ logo_url: 'not-a-url' }).success).toBe(false)
    expect(BrandSchema.safeParse({ hack: true }).success).toBe(false) // strict
  })

  it('OrgRowSchema catches malformed rows to safe defaults', () => {
    const row = OrgRowSchema.parse({
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      name: 'Acme',
      slug: 'acme-1234',
      owner_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      brand: 'garbage',
      plan: 'diamond',
      created_at: new Date().toISOString(),
    })
    expect(row.plan).toBe('free') // never over-grant
    expect(row.brand).toEqual({})
  })

  it('CreateOrgInput trims and bounds the name', () => {
    expect(CreateOrgInput.parse({ name: '  Acme Hiring  ' }).name).toBe('Acme Hiring')
    expect(CreateOrgInput.safeParse({ name: 'x' }).success).toBe(false)
    expect(CreateOrgInput.safeParse({ name: 'Acme', extra: 1 }).success).toBe(false)
  })

  it('CreateInviteInput — owner role is never invitable (docs/11 §2)', () => {
    expect(CreateInviteInput.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false)
    expect(CreateInviteInput.safeParse({ email: 'a@b.co', role: 'admin' }).success).toBe(true)
    expect(CreateInviteInput.safeParse({ email: 'nope', role: 'member' }).success).toBe(false)
  })

  it('SwitchWorkspaceInput / MoveJobInput shapes', () => {
    expect(SwitchWorkspaceInput.safeParse({ organization_id: null }).success).toBe(true)
    expect(SwitchWorkspaceInput.safeParse({}).success).toBe(false) // required key
    expect(MoveJobInput.safeParse({ organization_id: null }).success).toBe(true)
  })
})

describe('hashToken (invite tokens stored hashed — docs/04 §3.2)', () => {
  it('sha256 hex, deterministic, not the raw token', () => {
    const hash = hashToken('secret-token-123')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(hashToken('secret-token-123'))
    expect(hash).not.toContain('secret-token-123')
  })

  it('distinct tokens → distinct hashes', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'))
  })
})

describe('migration SQL sanity (docs/13 §Phase-4 — static checks)', () => {
  // Orgs schema was forward-designed: tables land in 0002 ("activated Phase 4"),
  // baseline RLS in 0004, and 0006 is the additive activation migration.
  const core = readFileSync('supabase/migrations/0002_core_tables.sql', 'utf8')
  const rls = readFileSync('supabase/migrations/0004_rls_and_triggers.sql', 'utf8')
  const sql = readFileSync('supabase/migrations/0006_phase4_orgs.sql', 'utf8')

  it('org tables were pre-created in 0002 (activated Phase 4)', () => {
    expect(core).toMatch(/create table public\.organizations/i)
    expect(core).toMatch(/create table public\.organization_members/i)
  })

  it('0006 creates the invite DDL', () => {
    expect(sql).toMatch(/create table if not exists public\.organization_invites/i)
  })

  it('security-definer helpers exist', () => {
    expect(sql).toMatch(/create or replace function public\.current_org_role/i)
    expect(sql).toMatch(/create or replace function public\.lookup_invite/i)
    expect(sql).toMatch(/create or replace function public\.accept_org_invite/i)
    expect(sql).toMatch(/security definer/i)
  })

  it('invite-citext + sha256 token hash + single-use expiry in DDL', () => {
    expect(sql).toMatch(/email\s+citext/i)
    expect(sql).toMatch(/token_hash\s+text\s+not null\s+unique/i)
    expect(sql).toMatch(/accepted_at\s+timestamptz/i)
  })

  it('RLS enabled on every org table (docs/07 §1)', () => {
    for (const table of ['organizations', 'organization_members']) {
      expect(rls).toMatch(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`, 'i'),
      )
    }
    expect(sql).toMatch(/alter table public\.organization_invites enable row level security/i)
  })

  it('org dedupe partial unique index on applicants (docs/11 §6)', () => {
    expect(sql).toMatch(/applicants_org_email_uniq/i)
    expect(sql).toMatch(/organization_id is not null/i)
  })

  it('backfill is guarded (re-runnable) and does not set defaults', () => {
    expect(sql).toMatch(/organization_members m\s+where m\.user_id = u\.id and m\.role = 'owner'/i)
    // Data rows must NOT be re-scoped by the migration (docs/11 §6.1)
    expect(sql).not.toMatch(/update public\.jobs set organization_id/i)
    expect(sql).not.toMatch(/update public\.users set default_organization_id/i)
  })

  it('current_org_role returns NULL for soft-deleted orgs', () => {
    expect(sql).toMatch(/deleted_at\s+is\s+null/i)
  })
})
