import { cn } from '@/lib/utils'

/** Skeleton — docs/06 §5: matches final layout; no spinners for initial loads. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-lg bg-slate-200', className)} />
}
