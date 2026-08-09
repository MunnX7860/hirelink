/**
 * Plans & limits — docs/11 §4 (normative data). Pure module (no framework) so the
 * matrix is trivially unit-tested; the 402-throwing wrapper lives in
 * features/orgs/server.ts (`assertWithinPlan`).
 *
 * Manual billing era (Phase 4): plans flip in the DB by the founder; Stripe is backlog.
 * Personal workspaces are governed by the `free` row (docs/11 §4).
 */
export type PlanId = 'free' | 'pro' | 'team'

export const PLAN_IDS: readonly PlanId[] = ['free', 'pro', 'team'] as const

export interface PlanLimits {
  /** Max jobs with status='active' per workspace. */
  jobsActive: number
  /** Max seats (members + pending invites both reserve — docs/11 §4). */
  seats: number
  /** Stored applications cap — surfacing only in Phase 4 (never blocks a candidate). */
  applicationsStored: number
  /** Custom branding on the public apply page (else "via HireLink" badge). */
  customBranding: boolean
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: { jobsActive: 3, seats: 1, applicationsStored: 500, customBranding: false },
  pro: { jobsActive: 25, seats: 3, applicationsStored: 10_000, customBranding: true },
  team: { jobsActive: 100, seats: 25, applicationsStored: 50_000, customBranding: true },
} as const

export const PLAN_PRICES: Record<PlanId, string> = {
  free: '$0',
  pro: '$12/mo',
  team: '$39/mo',
} as const

export type PlanLimitKey = 'jobs.active' | 'seats' | 'applications.stored'

const KEY_TO_FIELD: Record<
  PlanLimitKey,
  keyof Pick<PlanLimits, 'jobsActive' | 'seats' | 'applicationsStored'>
> = {
  'jobs.active': 'jobsActive',
  seats: 'seats',
  'applications.stored': 'applicationsStored',
}

export function limitFor(plan: PlanId, key: PlanLimitKey): number {
  return PLAN_LIMITS[plan][KEY_TO_FIELD[key]]
}

/** Null/invalid plan degrades to `free` — safest default (deny-growth, never over-grant). */
export function normalizePlan(plan: string | null | undefined): PlanId {
  return plan === 'pro' || plan === 'team' ? plan : 'free'
}

/** `used` = current usage BEFORE the action; the action succeeds when used < limit. */
export function isWithinPlan(plan: PlanId, key: PlanLimitKey, used: number): boolean {
  return used < limitFor(plan, key)
}

/** Error details payload for 402 PLAN_LIMIT (docs/05 §2). */
export function planLimitDetails(
  plan: PlanId,
  key: PlanLimitKey,
  used: number,
): { limit_key: PlanLimitKey; used: number; limit: number; plan: PlanId } {
  return { limit_key: key, used, limit: limitFor(plan, key), plan }
}

export function canUseCustomBranding(plan: PlanId): boolean {
  return PLAN_LIMITS[plan].customBranding
}
