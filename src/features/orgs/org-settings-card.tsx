'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Select } from '@/ui/select'
import { Badge } from '@/ui/badge'
import { ConfirmModal } from '@/ui/modal'
import { useToast } from '@/ui/toaster'
import { ApiError, mutate } from '@/lib/api-client'

/**
 * Organization settings — docs/02 §10 + docs/06 §4 (Settings → Workspace).
 * Create org · switcher shortcuts · members/roles · invites · plan usage ·
 * branding (owner, non-free) · danger zone. Role-restricted controls are hidden
 * for members (the server still enforces everything — docs/11 §2).
 */

export interface OrgListItem {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
}

export interface OrgMemberItem {
  user_id: string
  full_name: string | null
  email: string
  role: 'owner' | 'admin' | 'member'
}

export interface OrgInviteItem {
  id: string
  email: string
  role: string
  expires_at: string
}

export interface OrgDetailProps {
  id: string
  name: string
  plan: 'free' | 'pro' | 'team'
  brand: {
    logo_url?: string | null | undefined
    primary_color?: string | null | undefined
    email_from_name?: string | null | undefined
  }
  owner_id: string
  role: 'owner' | 'admin' | 'member'
  members: OrgMemberItem[]
  pending_invites: OrgInviteItem[]
  usage: { active_jobs: number; seats: number; applications: number }
  limits: { 'jobs.active': number; seats: number; 'applications.stored': number }
}

export function OrgSettingsCard({
  currentUserId,
  workspace,
  orgs,
  orgDetail,
}: {
  currentUserId: string
  workspace: { kind: 'personal' | 'org'; orgId?: string; orgName?: string; role?: string }
  orgs: OrgListItem[]
  orgDetail: OrgDetailProps | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  async function createOrg() {
    if (busy) return
    setBusy(true)
    try {
      await mutate('/api/orgs', 'POST', { name: newName.trim() })
      toast('Organization created 🎉 You can switch to it from the top bar.', { tone: 'success' })
      setNewName('')
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not create the organization.', {
        tone: 'danger',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card id="workspace">
      <CardHeader>
        <CardTitle>Workspace</CardTitle>
        <Badge tone={workspace.kind === 'org' ? 'success' : 'muted'}>
          {workspace.kind === 'org' ? `Org: ${workspace.orgName ?? ''}` : 'Personal'}
        </Badge>
      </CardHeader>

      {orgs.length > 0 ? (
        <ul className="mb-4 flex flex-col gap-2">
          {orgs.map((org) => (
            <li
              key={org.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate font-medium text-ink">
                {org.name}
                <span className="ml-1 font-normal text-ink-secondary">({org.role})</span>
                {workspace.orgId === org.id ? (
                  <span className="ml-1 text-brand">· active</span>
                ) : null}
              </span>
              {workspace.orgId !== org.id ? <SwitchButton orgId={org.id} /> : null}
            </li>
          ))}
          {workspace.kind === 'org' ? (
            <li>
              <SwitchButton orgId={null} label="Back to personal" />
            </li>
          ) : null}
        </ul>
      ) : null}

      <div className="flex items-end gap-2">
        <Input
          label="New organization"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="e.g. Sunrise Café team"
          minLength={2}
          maxLength={120}
        />
        <Button
          variant="secondary"
          size="md"
          onClick={createOrg}
          loading={busy}
          disabled={newName.trim().length < 2}
        >
          Create
        </Button>
      </div>

      {orgDetail ? <CurrentOrgSection detail={orgDetail} currentUserId={currentUserId} /> : null}
    </Card>
  )
}

function SwitchButton({ orgId, label = 'Switch' }: { orgId: string | null; label?: string }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await mutate('/api/orgs/current', 'POST', { organization_id: orgId })
          router.refresh()
        } catch {
          toast('Could not switch workspace.', { tone: 'danger' })
          setBusy(false)
        }
      }}
    >
      {label}
    </Button>
  )
}

function CurrentOrgSection({
  detail,
  currentUserId,
}: {
  detail: OrgDetailProps
  currentUserId: string
}) {
  const router = useRouter()
  const toast = useToast()
  const canManageMembers = detail.role === 'owner' || detail.role === 'admin'
  const isOrgOwner = detail.owner_id === currentUserId
  const [name, setName] = useState(detail.name)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [joinUrl, setJoinUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function run(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Something went wrong.', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-5 border-t border-slate-100 pt-5">
      {/* Plan + usage (docs/11 §4) */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink">
          Plan: <span className="capitalize">{detail.plan}</span>
        </h3>
        <dl className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg bg-surface-muted px-2 py-2">
            <dt className="text-[11px] uppercase tracking-wide text-ink-secondary">Active jobs</dt>
            <dd className="font-semibold text-ink">
              {detail.usage.active_jobs}/{detail.limits['jobs.active']}
            </dd>
          </div>
          <div className="rounded-lg bg-surface-muted px-2 py-2">
            <dt className="text-[11px] uppercase tracking-wide text-ink-secondary">Seats</dt>
            <dd className="font-semibold text-ink">
              {detail.usage.seats}/{detail.limits.seats}
            </dd>
          </div>
          <div className="rounded-lg bg-surface-muted px-2 py-2">
            <dt className="text-[11px] uppercase tracking-wide text-ink-secondary">Applications</dt>
            <dd className="font-semibold text-ink">
              {detail.usage.applications}/{detail.limits['applications.stored']}
            </dd>
          </div>
        </dl>
        {detail.plan === 'free' ? (
          <p className="mt-2 text-xs text-ink-secondary">
            Plans are upgraded manually during our early phase — talk to us to raise your limits.
          </p>
        ) : null}
      </section>

      {/* Rename (owner/admin) */}
      {canManageMembers ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">Organization name</h3>
          <div className="flex items-end gap-2">
            <Input
              label="Name"
              hideLabel
              value={name}
              onChange={(e) => setName(e.target.value)}
              minLength={2}
              maxLength={120}
            />
            <Button
              variant="secondary"
              size="md"
              loading={busy}
              disabled={name.trim().length < 2 || name.trim() === detail.name}
              onClick={() =>
                run(async () => {
                  await mutate(`/api/orgs/${detail.id}`, 'PATCH', { name: name.trim() })
                  toast('Renamed ✓', { tone: 'success' })
                })
              }
            >
              Save
            </Button>
          </div>
        </section>
      ) : null}

      {/* Members */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink">Members ({detail.members.length})</h3>
        <ul className="flex flex-col gap-2">
          {detail.members.map((m) => {
            const isRowOrgOwner = m.user_id === detail.owner_id
            const self = m.user_id === currentUserId
            return (
              <li
                key={m.user_id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">
                    {m.full_name ?? m.email} {self ? '(you)' : ''}
                  </p>
                  <p className="truncate text-xs text-ink-secondary">{m.email}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Badge tone={m.role === 'owner' ? 'success' : 'muted'}>{m.role}</Badge>
                  {canManageMembers && !isRowOrgOwner && !self ? (
                    <MemberControls
                      orgId={detail.id}
                      member={m}
                      actingIsOrgOwner={isOrgOwner}
                      busy={busy}
                      run={run}
                    />
                  ) : null}
                  {!isRowOrgOwner && self ? (
                    <LeaveButton orgId={detail.id} selfId={m.user_id} />
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>

        {/* Invites */}
        {canManageMembers ? (
          <div className="mt-3">
            <h4 className="mb-2 text-sm font-semibold text-ink">Invite a teammate</h4>
            <div className="flex items-end gap-2">
              <Input
                label="Email"
                hideLabel
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="teammate@example.com"
              />
              <Select
                label="Invite role"
                hideLabel
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'admin' | 'member')}
                className="text-sm"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </Select>
              <Button
                variant="secondary"
                size="md"
                loading={busy}
                disabled={!inviteEmail.includes('@')}
                onClick={() =>
                  run(async () => {
                    const res = (await mutate(`/api/orgs/${detail.id}/invites`, 'POST', {
                      email: inviteEmail.trim(),
                      role: inviteRole,
                    })) as { join_url?: string }
                    setJoinUrl(res?.join_url ?? null)
                    setInviteEmail('')
                    toast('Invite created ✓ Share the link or let the email reach them.', {
                      tone: 'success',
                    })
                  })
                }
              >
                Invite
              </Button>
            </div>
            {joinUrl ? (
              <p className="mt-2 break-all rounded-lg bg-surface-muted p-2 text-xs text-ink-secondary">
                One-time link (7 days): <span className="font-mono text-ink">{joinUrl}</span>
              </p>
            ) : null}
            {detail.pending_invites.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-secondary">
                {detail.pending_invites.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {inv.email} · {inv.role} · expires {inv.expires_at.slice(0, 10)}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-danger hover:underline"
                      onClick={() =>
                        run(async () => {
                          await mutate(`/api/orgs/${detail.id}/invites/${inv.id}`, 'DELETE')
                          toast('Invite revoked', { tone: 'info' })
                        })
                      }
                    >
                      revoke
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Branding (org owner, non-free — docs/11 §4/§9) */}
      {isOrgOwner ? <BrandingSection detail={detail} busy={busy} run={run} /> : null}

      {/* Danger zone */}
      {isOrgOwner ? (
        <section className="rounded-lg border border-danger/30 p-3">
          <h3 className="text-sm font-semibold text-danger">Danger zone</h3>
          <p className="mt-1 text-xs text-ink-secondary">
            Deleting the organization removes everyone’s access instantly. You have 7 days to
            restore it; after that it is purged and all jobs/applicants return to their creators’
            personal workspaces. Export your data (People → Export CSV) first if you need it.
          </p>
          <Button
            variant="danger"
            size="sm"
            className="mt-2"
            onClick={() => setConfirmDelete(true)}
          >
            Delete organization
          </Button>
          <ConfirmModal
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete ${detail.name}?`}
            description="Members are locked out immediately. You can restore within 7 days from your workspace list. No jobs or applicants are deleted — they return to their creators' personal workspaces after purge."
            confirmLabel="Delete organization"
            loading={busy}
            onConfirm={() =>
              run(async () => {
                await mutate(`/api/orgs/${detail.id}`, 'DELETE')
                await mutate('/api/orgs/current', 'POST', { organization_id: null })
                toast('Organization deleted (7-day restore window)', { tone: 'info' })
              })
            }
          />
        </section>
      ) : null}
    </div>
  )
}

function MemberControls({
  orgId,
  member,
  actingIsOrgOwner,
  busy,
  run,
}: {
  orgId: string
  member: OrgMemberItem
  actingIsOrgOwner: boolean
  busy: boolean
  run: (fn: () => Promise<void>) => Promise<void>
}) {
  const toast = useToast()
  const canDemoteAdmin = member.role === 'admin' ? actingIsOrgOwner : true
  return (
    <>
      {canDemoteAdmin ? (
        <button
          type="button"
          disabled={busy}
          className="text-xs text-brand hover:underline disabled:opacity-50"
          onClick={() =>
            run(async () => {
              await mutate(`/api/orgs/${orgId}/members/${member.user_id}`, 'PATCH', {
                role: member.role === 'admin' ? 'member' : 'admin',
              })
              toast('Role updated ✓', { tone: 'success' })
            })
          }
        >
          {member.role === 'admin' ? 'make member' : 'make admin'}
        </button>
      ) : null}
      <button
        type="button"
        disabled={busy}
        className="text-xs text-danger hover:underline disabled:opacity-50"
        onClick={() =>
          run(async () => {
            await mutate(`/api/orgs/${orgId}/members/${member.user_id}`, 'DELETE')
            toast('Member removed', { tone: 'info' })
          })
        }
      >
        remove
      </button>
    </>
  )
}

function LeaveButton({ orgId, selfId }: { orgId: string; selfId: string }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      className="text-xs text-danger hover:underline disabled:opacity-50"
      onClick={async () => {
        setBusy(true)
        try {
          await mutate(`/api/orgs/${orgId}/members/${selfId}`, 'DELETE')
          await mutate('/api/orgs/current', 'POST', { organization_id: null })
          toast('You left the organization', { tone: 'info' })
          router.refresh()
        } catch (err) {
          toast(err instanceof ApiError ? err.message : 'Could not leave.', { tone: 'danger' })
          setBusy(false)
        }
      }}
    >
      leave
    </button>
  )
}

function BrandingSection({
  detail,
  busy,
  run,
}: {
  detail: OrgDetailProps
  busy: boolean
  run: (fn: () => Promise<void>) => Promise<void>
}) {
  const toast = useToast()
  const locked = detail.plan === 'free'
  const [fromName, setFromName] = useState(detail.brand.email_from_name ?? '')
  const [color, setColor] = useState(detail.brand.primary_color ?? '')
  const [logoUrl, setLogoUrl] = useState(detail.brand.logo_url ?? '')

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-ink">
        Branding {locked ? <Badge tone="muted">Pro+</Badge> : null}
      </h3>
      {locked ? (
        <p className="text-xs text-ink-secondary">
          Custom branding on your apply pages and emails is a Pro/Team feature. Upgrade to make them
          yours — free workspaces show a “via HireLink” badge.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Input
            label="From-name (emails)"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
            placeholder={detail.name}
            maxLength={80}
          />
          <Input
            label="Accent color (hex)"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="#4f46e5"
            maxLength={7}
          />
          <Input
            label="Logo URL (apply page)"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://…/logo.png"
          />
          <div>
            <Button
              variant="secondary"
              size="md"
              loading={busy}
              onClick={() =>
                run(async () => {
                  await mutate(`/api/orgs/${detail.id}`, 'PATCH', {
                    brand: {
                      email_from_name: fromName.trim() || null,
                      primary_color: color.trim() || null,
                      logo_url: logoUrl.trim() || null,
                    },
                  })
                  toast('Branding saved ✓', { tone: 'success' })
                })
              }
            >
              Save branding
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
