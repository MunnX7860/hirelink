'use client'

import { Button } from '@/ui/button'

/** Public-surface error boundary — docs/03 §6: applicant-facing errors are human (docs/02 §10). */
export default function PublicError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 p-6 pt-16 text-center">
      <h1 className="text-xl font-semibold text-ink">Something went wrong on our side</h1>
      <p className="text-sm text-ink-secondary">
        We couldn’t load this page. Please try again — your application, if you already submitted
        one, is safe.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
