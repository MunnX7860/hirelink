'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/ui/button'
import { useToast } from '@/ui/toaster'
import { mutate } from '@/lib/api-client'

export interface ChooserOrg {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
}

/**
 * One-time workspace chooser — docs/11 §6, docs/02 §10.1. Surfaces exactly once
 * (server gate is `needsWorkspaceChooser()`, features/orgs/server.ts) for a user
 * who has >=1 org membership but has never explicitly picked personal-vs-org.
 * Both choices persist via the existing `POST /api/orgs/current` switch path
 * (which also stamps `workspace_onboarded_at`, migration 0010) — the modal
 * itself holds no extra state beyond "which button is in flight."
 */
export function WorkspaceChooserModal({ orgs }: { orgs: ChooserOrg[] }) {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const router = useRouter()
  const toast = useToast()

  async function choose(organizationId: string | null, label: string) {
    if (busy) return
    setBusy(organizationId ?? 'personal')
    try {
      await mutate('/api/orgs/current', 'POST', { organization_id: organizationId })
      setOpen(false)
      toast(`Workspace set to ${label}`, { tone: 'success' })
      router.refresh()
    } catch {
      toast('Could not set your workspace — use the switcher in the top bar instead.', {
        tone: 'danger',
      })
      setOpen(false)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={() => {}}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40" />
        <Dialog.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-[12px] bg-surface p-6 shadow-xl"
        >
          <Dialog.Title className="text-lg font-semibold text-ink">Which workspace?</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-ink-secondary">
            {orgs.length === 1
              ? "You're part of a team workspace now."
              : `You're part of ${orgs.length} team workspaces now.`}{' '}
            Pick where you&apos;d like to start — you can switch anytime from the top bar.
          </Dialog.Description>
          <div className="mt-4 flex flex-col gap-2">
            {orgs.map((org) => (
              <Button
                key={org.id}
                variant="secondary"
                className="w-full justify-between"
                loading={busy === org.id}
                disabled={busy !== null && busy !== org.id}
                onClick={() => choose(org.id, org.name)}
              >
                <span className="truncate">{org.name}</span>
                <span className="text-xs text-ink-secondary">{org.role}</span>
              </Button>
            ))}
          </div>
          <Button
            variant="ghost"
            className="mt-3 w-full"
            loading={busy === 'personal'}
            disabled={busy !== null && busy !== 'personal'}
            onClick={() => choose(null, 'Personal')}
          >
            Stay on my personal workspace
          </Button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
