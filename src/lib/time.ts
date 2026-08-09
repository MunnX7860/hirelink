/** Client-safe relative time ("3m ago") for cards and timeline (docs/02 §5). */
export function relativeTime(iso: string | Date, now: Date = new Date()): string {
  const then = typeof iso === 'string' ? new Date(iso) : iso
  const diffSec = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000))
  if (diffSec < 45) return 'just now'
  const mins = Math.round(diffSec / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.round(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
