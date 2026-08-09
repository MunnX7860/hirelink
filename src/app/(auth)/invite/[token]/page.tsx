import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AppError } from '@/lib/errors'
import { lookupInvite } from '@/features/orgs/server'
import { InviteAcceptButton } from '@/features/orgs/invite-accept-button'
import { Card } from '@/ui/card'

export const metadata: Metadata = { title: 'Team invite' }
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ token: string }> }

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-surface-muted p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Link
          href="/login"
          className="self-center text-2xl font-bold tracking-tight text-ink"
          aria-label="HireLink home"
        >
          Hire<span className="text-brand">Link</span>
        </Link>
        {children}
      </div>
    </main>
  )
}

/**
 * Invite landing — docs/02 §10.3 + docs/05 §4.9. Signed-out visitors are sent to
 * login with ?next back here (Google sign-in forwards it — docs/02 §1). The peek
 * (org, role, inviter) comes from the security-definer lookup_invite RPC; the
 * final accept re-validates everything atomically.
 */
export default async function InvitePage({ params }: RouteContext) {
  const { token } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)

  try {
    const invite = await lookupInvite(supabase, token)
    const userEmail = user.email?.toLowerCase() ?? ''

    if (invite.email.toLowerCase() !== userEmail) {
      return (
        <Shell>
          <Card className="flex flex-col items-center gap-3 px-6 py-8 text-center">
            <span aria-hidden className="text-3xl">
              ✉️
            </span>
            <h1 className="text-lg font-semibold text-ink">Wrong account</h1>
            <p className="text-sm text-ink-secondary">
              This invite was sent to <strong>{invite.email}</strong>. You’re signed in as{' '}
              <strong>{user.email}</strong>. Sign out and continue with the invited account.
            </p>
            <Link href="/dashboard" className="text-sm font-medium text-brand underline">
              Back to my dashboard
            </Link>
          </Card>
        </Shell>
      )
    }

    return (
      <Shell>
        <Card className="flex flex-col items-center gap-3 px-6 py-8 text-center">
          <span aria-hidden className="text-3xl">
            🤝
          </span>
          <h1 className="text-lg font-semibold text-ink">
            Join {invite.org_name}
            {invite.inviter_name ? (
              <span className="mt-1 block text-sm font-normal text-ink-secondary">
                Invited by {invite.inviter_name}
              </span>
            ) : null}
          </h1>
          <p className="text-sm text-ink-secondary">
            You’ll join as <strong className="text-ink">{invite.role}</strong> — you’ll see the
            workspace’s jobs and applicants, and can switch back to your personal workspace anytime.
          </p>
          <InviteAcceptButton token={token} />
        </Card>
      </Shell>
    )
  } catch (err) {
    if (err instanceof AppError) {
      return (
        <Shell>
          <Card className="flex flex-col items-center gap-3 px-6 py-8 text-center">
            <span aria-hidden className="text-3xl">
              ⏳
            </span>
            <h1 className="text-lg font-semibold text-ink">Invite no longer valid</h1>
            <p className="text-sm text-ink-secondary">{err.message}</p>
            <Link href="/dashboard" className="text-sm font-medium text-brand underline">
              Go to my dashboard
            </Link>
          </Card>
        </Shell>
      )
    }
    throw err
  }
}
