import type { Metadata } from 'next'
import Link from 'next/link'
import { Card } from '@/ui/card'
import { Banner } from '@/ui/banner'
import { GoogleSignInButton } from '@/features/auth/google-sign-in-button'

export const metadata: Metadata = { title: 'Sign in' }

/**
 * Login — docs/02 §1 + docs/06 §4. Exactly one primary action: Continue with Google.
 * OAuth failures return here with ?error=oauth (auth callback).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const oauthFailed = params.error === 'oauth'

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

        {oauthFailed ? (
          <Banner tone="danger" title="Google sign-in didn’t work">
            Please try again. If it keeps failing, check your connection.
          </Banner>
        ) : null}

        <Card className="flex flex-col items-center gap-4 px-6 py-8 text-center">
          <div>
            <h1 className="text-xl font-semibold text-ink">Hire from your audience</h1>
            <p className="mt-1 text-sm text-ink-secondary">
              Create a hiring link, share it anywhere, and track every applicant in one place.
            </p>
          </div>
          <GoogleSignInButton />
        </Card>

        <p className="text-center text-xs text-ink-secondary">
          By continuing you agree to receive transactional emails about your account.
        </p>
      </div>
    </main>
  )
}
