import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-5xl font-bold text-brand">404</p>
      <p className="text-sm text-ink-secondary">This page doesn’t exist.</p>
      <Link href="/dashboard" className="font-medium text-brand hover:text-brand-hover">
        Go to dashboard
      </Link>
    </div>
  )
}
