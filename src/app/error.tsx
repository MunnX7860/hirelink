'use client'

import { Button } from '@/ui/button'

/** Segment error boundary — docs/14 §4 / docs/06 §5: message + Retry, never a naked crash. */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold text-ink">Something went wrong</h1>
      <p className="max-w-sm text-sm text-ink-secondary">
        The page failed to load. Please try again — if it keeps happening, contact support.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
