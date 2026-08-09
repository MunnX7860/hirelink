import { z } from 'zod'
import { MEMBER_ROLES, type MemberRole } from '@/lib/authz'
import { PLAN_IDS, type PlanId } from '@/lib/plans'

/**
 * Org feature schemas — docs/05 §4.9, docs/11. Shared client/server (zod strict;
 * unknown fields rejected per docs/05 §1 conventions).
 */

export const MemberRoleSchema = z.enum(MEMBER_ROLES as [MemberRole, ...MemberRole[]])
export const PlanIdSchema = z.enum(PLAN_IDS as [PlanId, ...PlanId[]])

/** docs/04 §3.2 — brand jsonb. All fields optional; empty object resets. */
export const BrandSchema = z
  .object({
    logo_url: z.string().url().max(500).nullish(),
    primary_color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #4f46e5')
      .nullish(),
    email_from_name: z.string().trim().min(2).max(80).nullish(),
  })
  .strict()
export type BrandValue = z.infer<typeof BrandSchema>

export const OrgRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  owner_id: z.string().uuid(),
  brand: BrandSchema.catch({}),
  plan: PlanIdSchema.catch('free'),
  created_at: z.string(),
})
export type OrgRow = z.infer<typeof OrgRowSchema>

export const CreateOrgInput = z
  .object({
    name: z.string().trim().min(2).max(120),
  })
  .strict()
export type CreateOrgInputValue = z.infer<typeof CreateOrgInput>

export const UpdateOrgInput = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    brand: BrandSchema.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.brand !== undefined, {
    message: 'Nothing to update.',
  })
export type UpdateOrgInputValue = z.infer<typeof UpdateOrgInput>

export const SwitchWorkspaceInput = z
  .object({
    organization_id: z.string().uuid().nullable(),
  })
  .strict()
export type SwitchWorkspaceInputValue = z.infer<typeof SwitchWorkspaceInput>

export const CreateInviteInput = z
  .object({
    email: z.string().trim().email().max(320),
    role: z.enum(['admin', 'member']),
  })
  .strict()
export type CreateInviteInputValue = z.infer<typeof CreateInviteInput>

export const UpdateMemberInput = z
  .object({
    role: z.enum(['admin', 'member']), // owner role never assigned here (docs/11 §2)
  })
  .strict()
export type UpdateMemberInputValue = z.infer<typeof UpdateMemberInput>

export const TransferOrgInput = z
  .object({
    user_id: z.string().uuid(),
  })
  .strict()
export type TransferOrgInputValue = z.infer<typeof TransferOrgInput>

export const MoveJobInput = z
  .object({
    organization_id: z.string().uuid().nullable(),
  })
  .strict()
export type MoveJobInputValue = z.infer<typeof MoveJobInput>

// ── API view shapes (docs/05 §4.9) ────────────────────────────────────────────

export interface WorkspaceView {
  kind: 'personal' | 'org'
  org?: (OrgRow & { role: MemberRole }) | undefined
}

export interface OrgMemberView {
  user_id: string
  full_name: string | null
  email: string
  role: MemberRole
  created_at: string
}

export interface OrgUsageView {
  active_jobs: number
  seats: number
  applications: number
}

export interface PendingInviteView {
  id: string
  email: string
  role: MemberRole
  expires_at: string
  created_at: string
}

export const INVITE_TTL_DAYS = 7 as const
