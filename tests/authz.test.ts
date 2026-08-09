import { describe, it, expect } from 'vitest'
import {
  can,
  isOrgOwnerOnly,
  MEMBER_ROLES,
  ORG_OWNER_ONLY,
  type Capability,
  type MemberRole,
} from '@/lib/authz'

/**
 * Role × capability matrix — docs/11 §2 (normative) + docs/13 §Phase-4.
 * This table IS the authorization contract: if a row changes here, docs/11 §2
 * must change in the same commit (docs-first workflow).
 */

const ALL_CAPABILITIES: Capability[] = [
  'jobs.write',
  'applications.write',
  'integrations.manage',
  'org.rename',
  'members.manage',
  'org.branding',
  'org.transfer',
  'org.delete',
]

/** Expected grants — mirrors the docs/11 §2 matrix EXACTLY. */
const MATRIX: Record<MemberRole, readonly Capability[]> = {
  owner: ALL_CAPABILITIES,
  admin: [
    'jobs.write',
    'applications.write',
    'integrations.manage',
    'org.rename',
    'members.manage',
  ],
  member: ['jobs.write', 'applications.write'],
}

describe('can() — full role × capability grid (docs/11 §2)', () => {
  for (const role of MEMBER_ROLES) {
    describe(role, () => {
      for (const capability of ALL_CAPABILITIES) {
        const expected = MATRIX[role].includes(capability)
        it(`${role} ${expected ? 'CAN' : 'CANNOT'} ${capability}`, () => {
          expect(can(role, capability)).toBe(expected)
        })
      }
    })
  }
})

describe('can() — defensive denials', () => {
  it('denies null/undefined roles', () => {
    expect(can(null, 'jobs.write')).toBe(false)
    expect(can(undefined, 'jobs.write')).toBe(false)
  })

  it('denies unknown roles (cast-safe)', () => {
    expect(can('superadmin' as MemberRole, 'jobs.write')).toBe(false)
  })
})

describe('org-owner-only capabilities (docs/11 §2 — org.branding/transfer/delete)', () => {
  it('exactly the org-owner row is marked owner-only', () => {
    expect([...ORG_OWNER_ONLY].sort()).toEqual(['org.branding', 'org.delete', 'org.transfer'])
  })

  it('owner-only capabilities are not even in the admin grid', () => {
    for (const capability of ORG_OWNER_ONLY) {
      expect(can('admin', capability)).toBe(false)
    }
  })

  it('isOrgOwnerOnly identifies them and nothing else', () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(isOrgOwnerOnly(capability)).toBe(ORG_OWNER_ONLY.includes(capability))
    }
  })
})

describe('members (docs/11 §2)', () => {
  it('can do day-to-day hiring work but nothing administrative', () => {
    expect(can('member', 'jobs.write')).toBe(true)
    expect(can('member', 'applications.write')).toBe(true)
    expect(can('member', 'integrations.manage')).toBe(false)
    expect(can('member', 'members.manage')).toBe(false)
    expect(can('member', 'org.rename')).toBe(false)
  })
})
