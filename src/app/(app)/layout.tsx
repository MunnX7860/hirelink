import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { BottomTabs } from '@/features/shell/bottom-tabs'
import { SignOutButton } from '@/features/auth/sign-out-button'
import { Providers } from '@/app/(app)/providers'
import { getMemberships, resolveWorkspace } from '@/features/orgs/server'
import { WorkspaceSwitcher } from '@/features/orgs/workspace-switcher'

/**
 * Authenticated app shell — docs/06 §4: top bar + bottom tab bar on mobile
 * (Inbox · Jobs · People · Settings), left rail ≥ lg. Middleware is the primary
 * guard; this layout re-checks auth as a server-side backstop (defense in depth).
 * Phase 4 (docs/02 §10.2): the workspace switcher lives in the top bar and is
 * rendered as soon as the user belongs to ≥1 organization.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const displayName = user.user_metadata?.full_name ?? user.email ?? 'Account'
  const [memberships, scope] = await Promise.all([
    getMemberships(supabase, user.id).catch(() => []),
    resolveWorkspace(supabase, user.id),
  ])
  const currentOrg =
    scope.kind === 'org' ? memberships.find((m) => m.org.id === scope.orgId)?.org : undefined

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-slate-200 bg-surface px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight text-ink">
            Hire<span className="text-brand">Link</span>
          </Link>
          {memberships.length > 0 ? (
            <WorkspaceSwitcher
              current={
                currentOrg
                  ? { kind: 'org', orgId: currentOrg.id, name: currentOrg.name }
                  : { kind: 'personal' }
              }
              orgs={memberships.map((m) => ({ id: m.org.id, name: m.org.name, role: m.role }))}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span
            className="flex size-8 items-center justify-center rounded-full bg-brand/10 text-sm font-semibold text-brand"
            title={displayName}
            aria-label={`Signed in as ${displayName}`}
          >
            {(displayName as string).slice(0, 1).toUpperCase()}
          </span>
          <SignOutButton />
        </div>
      </header>

      {/* Content — bottom padding clears the mobile tab bar */}
      <main className="flex-1 pb-24 lg:pb-8 lg:pl-16">
        <Providers>{children}</Providers>
      </main>

      {/* Mobile bottom tabs / lg rail (responsive inside) */}
      <BottomTabs />
    </div>
  )
}
