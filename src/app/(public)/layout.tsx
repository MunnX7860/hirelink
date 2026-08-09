import Link from 'next/link'

/**
 * Public surface layout (apply pages) — docs/06 §4: minimal, fast, no app chrome.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-muted">
      <header className="flex h-14 items-center justify-center border-b border-slate-200 bg-surface">
        <Link
          href="/login"
          className="text-lg font-bold tracking-tight text-ink"
          aria-label="HireLink"
        >
          Hire<span className="text-brand">Link</span>
        </Link>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="p-4 text-center text-xs text-ink-secondary">
        Your resume is stored securely by the employer.
      </footer>
    </div>
  )
}
