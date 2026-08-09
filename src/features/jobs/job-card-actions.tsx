'use client'

import { DropdownMenu, DropdownItem } from '@/ui/dropdown-menu'
import { useToast } from '@/ui/toaster'
import { useRouter } from 'next/navigation'

/** Job card quick actions — copy link (docs/02 §3) + open detail. */
export function JobCardActions({ jobId, applyUrl }: { jobId: string; applyUrl: string }) {
  const toast = useToast()
  const router = useRouter()

  async function copy() {
    try {
      await navigator.clipboard.writeText(applyUrl)
      toast('Link copied ✓', { tone: 'success' })
    } catch {
      toast('Could not copy the link.', { tone: 'danger' })
    }
  }

  return (
    <DropdownMenu
      trigger={
        <button
          aria-label="Job actions"
          className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-slate-100"
        >
          ⋯
        </button>
      }
    >
      <DropdownItem onSelect={copy}>Copy hiring link</DropdownItem>
      <DropdownItem onSelect={() => router.push(`/dashboard/jobs/${jobId}`)}>Open job</DropdownItem>
    </DropdownMenu>
  )
}
