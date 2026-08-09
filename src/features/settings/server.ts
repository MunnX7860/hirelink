import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, ErrorCode } from '@/lib/errors'
import { logger, errorSummary } from '@/lib/logger'
import { applyScope, jobEmbedFilters, withFilters, type PersonalScope } from '@/features/orgs/scope'

/**
 * Account-level settings service — docs/02 §9 (Owner Account & Danger Zone),
 * docs/04 §8 (Data Lifecycle & Compliance). Both operations below only ever
 * touch the CALLER's own personal-workspace data (never org-shared rows) —
 * org data belongs to the workspace, not to any one member.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- user/service clients differ only by generics
type Client = SupabaseClient<any>

const EXPORT_ROW_CAP = 5_000 // mirrors the docs/05 §4.5 CSV-export cap posture

/**
 * Personal-data export (docs/02 §9: "Export my data"). Only the PERSONAL slice
 * (organization_id IS NULL) — org-shared data isn't solely the caller's to
 * export. Credentials are never selected (docs/05 §4.6 write-only rule).
 */
export async function exportOwnData(client: Client, userId: string) {
  const personal: PersonalScope = { kind: 'personal', ownerId: userId }

  const [profile, jobs, applicants, applications, notes, tags, integrations] = await Promise.all([
    client
      .from('users')
      .select('id, email, full_name, notify_telegram, notify_applicant_email, created_at')
      .eq('id', userId)
      .single(),
    applyScope(
      client
        .from('jobs')
        .select('id, title, description, slug, status, form_config, created_at, updated_at'),
      personal,
    ).limit(EXPORT_ROW_CAP),
    applyScope(
      client.from('applicants').select('id, full_name, email, phone, source, created_at'),
      personal,
    ).limit(EXPORT_ROW_CAP),
    withFilters(
      client
        .from('applications')
        .select('id, job_id, applicant_id, status, source_meta, applied_at, jobs!inner(id)'),
      jobEmbedFilters(personal),
    ).limit(EXPORT_ROW_CAP),
    client
      .from('notes')
      .select('id, applicant_id, application_id, body, created_at')
      .eq('owner_id', userId)
      .limit(EXPORT_ROW_CAP),
    applyScope(client.from('tags').select('id, name, color, created_at'), personal).limit(
      EXPORT_ROW_CAP,
    ),
    applyScope(
      client.from('integrations').select('id, type, status, config, created_at'),
      personal,
    ),
  ])

  if (profile.error) {
    throw new AppError(ErrorCode.INTERNAL, 'Could not export your data.', { cause: profile.error })
  }

  return {
    exported_at: new Date().toISOString(),
    note: `Personal-workspace data only (organization_id IS NULL); rows per table capped at ${EXPORT_ROW_CAP}. Resume files stay in your Google Drive and aren't included here.`,
    profile: profile.data,
    jobs: jobs.data ?? [],
    applicants: applicants.data ?? [],
    applications: (applications.data ?? []).map(
      ({ jobs: _jobs, ...row }: Record<string, unknown>) => row,
    ),
    notes: notes.data ?? [],
    tags: tags.data ?? [],
    integrations: integrations.data ?? [],
  }
}

const ORG_SCOPED_OWNERSHIP_TABLES = ['jobs', 'applicants', 'tags', 'integrations'] as const

/**
 * Deletes the caller's own account (docs/02 §9: "removes DB rows + stored
 * tokens, never the user's Drive files"). Requires the service client for
 * `auth.admin.deleteUser` (GoTrue admin API — there's no other way to remove
 * your own auth.users row; this is NOT an RLS bypass, it's the Auth Admin API,
 * a separate system docs/03 §Rules' service-client restriction doesn't cover —
 * see the eslint.config.mjs zone comment for this route).
 *
 * Safety: `organizations.owner_id` has no ON DELETE cascade (Postgres default
 * NO ACTION), so deleting while still owning a live org would hit a raw FK
 * error — checked here first for a friendly message instead. More importantly,
 * `jobs`/`applicants`/`tags`/`integrations.owner_id` DO cascade, and none of
 * those FKs care whether `organization_id` is set — an org member's personal
 * account deletion would otherwise cascade-delete data their whole team shares
 * (exactly the four tables `purgeDeletedOrgs` already treats as org-scoped).
 * Blocked rather than silently reassigned: reassignment ownership is an org
 * decision, not something account deletion should decide unilaterally.
 */
export async function deleteOwnAccount(serviceClient: Client, userId: string): Promise<void> {
  const { count: ownedOrgs, error: ownedOrgsError } = await serviceClient
    .from('organizations')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId)
    .is('deleted_at', null)
  if (ownedOrgsError) {
    throw new AppError(ErrorCode.INTERNAL, 'Could not check your organizations.', {
      cause: ownedOrgsError,
    })
  }
  if ((ownedOrgs ?? 0) > 0) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'You still own an organization. Transfer ownership (or delete it) in Settings → Workspace before deleting your account.',
    )
  }

  const blocking: Record<string, number> = {}
  for (const table of ORG_SCOPED_OWNERSHIP_TABLES) {
    const { count, error } = await serviceClient
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', userId)
      .not('organization_id', 'is', null)
    if (error) {
      throw new AppError(ErrorCode.INTERNAL, 'Could not check your workspace data.', {
        cause: error,
      })
    }
    if ((count ?? 0) > 0) blocking[table] = count as number
  }
  if (Object.keys(blocking).length > 0) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'You own data inside a shared workspace (jobs, candidates, tags, or a connected integration). Ask a workspace admin to reassign it, or move your jobs to your personal workspace, before deleting your account.',
      { details: blocking },
    )
  }

  const { error } = await serviceClient.auth.admin.deleteUser(userId)
  if (error) {
    logger.error('account deletion failed', { user_id: userId, ...errorSummary(error) })
    throw new AppError(ErrorCode.INTERNAL, 'Could not delete your account. Please try again.', {
      cause: error,
    })
  }
}
