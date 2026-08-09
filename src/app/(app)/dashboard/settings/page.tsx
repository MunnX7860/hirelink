import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getScopedIntegration } from '@/lib/integrations/resolve'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Banner } from '@/ui/banner'
import { ProfileSettings } from '@/features/settings/profile-settings'
import { IntegrationsSettings } from '@/features/settings/integrations-settings'
import { OrgSettingsCard } from '@/features/orgs/org-settings-card'
import { getMemberships, getOrgDetail, resolveWorkspace } from '@/features/orgs/server'
import type { BrandValue } from '@/features/orgs/schemas'
import { refForScope } from '@/features/orgs/scope'
import { can } from '@/lib/authz'
import { features } from '@/lib/env'

export const metadata: Metadata = { title: 'Settings' }
export const dynamic = 'force-dynamic'

/**
 * Settings — docs/06 §4: Profile (notification toggles), Workspace (orgs/team —
 * docs/02 §10), Integrations (Drive, Telegram, Email, AI — workspace-scoped,
 * docs/11 §3: org row first, personal fallback, level labelled in the UI).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const scope = await resolveWorkspace(supabase, user.id)
  const ref = refForScope(scope)
  const params = await searchParams

  const [profileRes, memberships, drive, telegram, ai] = await Promise.all([
    supabase
      .from('users')
      .select('email, full_name, notify_telegram, notify_applicant_email')
      .eq('id', user.id)
      .single(),
    getMemberships(supabase, user.id),
    getScopedIntegration(supabase, ref, 'google_drive'),
    getScopedIntegration(supabase, ref, 'telegram'),
    getScopedIntegration(supabase, ref, 'ai'),
  ])
  const profile = profileRes.data

  const activeMembership =
    scope.kind === 'org' ? memberships.find((m) => m.org.id === scope.orgId) : undefined
  const orgDetail = scope.kind === 'org' ? await getOrgDetail(supabase, scope, scope.orgId) : null

  const canManageIntegrations = scope.kind === 'org' ? can(scope.role, 'integrations.manage') : true

  const driveError = typeof params.drive_error === 'string' ? params.drive_error : null
  const connected = typeof params.connected === 'string' ? params.connected : null

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-xl font-bold text-ink">Settings</h1>

      {connected === 'google_drive' ? (
        <Banner tone="success" title="Google Drive connected ✅">
          Pick a root folder below so resumes have a home.
        </Banner>
      ) : null}
      {driveError ? (
        <Banner tone="danger" title="Google Drive connection failed">
          {{
            oauth: 'Google sign-in was cancelled.',
            state: 'The secure handshake expired — try again.',
            no_refresh_token: 'Google did not return offline access — try again.',
            exchange: 'The connection handshake failed — try again.',
            session: 'You were signed out mid-flow — try again.',
            org: "That organization connection isn't allowed for your role.",
          }[driveError] ?? 'Please try connecting again.'}
        </Banner>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <dl className="mb-4 flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-secondary">Name</dt>
            <dd className="font-medium text-ink">{profile?.full_name ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-secondary">Email</dt>
            <dd className="font-medium text-ink">{profile?.email ?? user.email}</dd>
          </div>
        </dl>
        <ProfileSettings
          notifyTelegram={profile?.notify_telegram ?? true}
          notifyApplicantEmail={profile?.notify_applicant_email ?? true}
        />
      </Card>

      <OrgSettingsCard
        currentUserId={user.id}
        workspace={
          scope.kind === 'org'
            ? {
                kind: 'org',
                orgId: scope.orgId,
                orgName: activeMembership?.org.name ?? orgDetail?.org.name ?? 'Organization',
                role: scope.role,
              }
            : { kind: 'personal' }
        }
        orgs={memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }))}
        orgDetail={
          orgDetail
            ? {
                id: orgDetail.org.id,
                name: orgDetail.org.name,
                plan: orgDetail.org.plan,
                brand: orgDetail.org.brand as BrandValue,
                owner_id: orgDetail.org.owner_id,
                role: orgDetail.role,
                members: orgDetail.members.map((m) => ({
                  user_id: m.user_id,
                  full_name: m.full_name,
                  email: m.email,
                  role: m.role,
                })),
                pending_invites: orgDetail.pending_invites.map((i) => ({
                  id: i.id,
                  email: i.email,
                  role: i.role,
                  expires_at: i.expires_at,
                })),
                usage: orgDetail.usage,
                limits: orgDetail.limits,
              }
            : null
        }
      />

      <IntegrationsSettings
        workspace={{
          kind: scope.kind,
          orgId: scope.kind === 'org' ? scope.orgId : null,
          canManageIntegrations,
        }}
        drive={
          drive && drive.row.status !== 'disconnected'
            ? {
                status: drive.row.status,
                level: drive.level,
                rootFolderSet: Boolean(
                  (drive.row.config as { root_folder_id?: string }).root_folder_id,
                ),
              }
            : null
        }
        telegram={
          telegram && telegram.row.status !== 'disconnected'
            ? {
                status: telegram.row.status,
                level: telegram.level,
                chatId: (telegram.row.config as { chat_id?: string }).chat_id ?? null,
                botUsername:
                  (telegram.row.config as { bot_username?: string | null }).bot_username ?? null,
                shared: Boolean((telegram.row.config as { shared?: boolean }).shared),
              }
            : null
        }
        emailConfigured={features.email}
        driveOAuthConfigured={features.googleDriveOAuth}
        sharedBotAvailable={features.sharedTelegramBot}
        ai={
          ai && ai.row.status !== 'disconnected'
            ? {
                status: ai.row.status === 'active' ? ('active' as const) : ('error' as const),
                level: ai.level,
                model: (ai.row.config as { model?: string }).model ?? 'gemini-2.0-flash',
                keyHint: (ai.row.config as { key_hint?: string }).key_hint ?? null,
              }
            : null
        }
      />
    </div>
  )
}
