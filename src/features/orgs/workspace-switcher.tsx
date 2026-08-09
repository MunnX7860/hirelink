'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DropdownMenu, DropdownItem } from '@/ui/dropdown-menu'
import { useToast } from '@/ui/toaster'
import { IconUsers } from '@/ui/icons'
import { mutate } from '@/lib/api-client'

export interface SwitcherOrg {
  id: string
  name: string
  role: 'owner' | 'admin' | 'member'
}

/**
 * Workspace switcher — docs/02 §10.2, docs/11 §1. Sits in the app-shell top bar:
 * pill shows the active workspace; switching POSTs /api/orgs/current (validates
 * membership, sets cookie + default) then hard-refreshes all server data.
 */
export function WorkspaceSwitcher({
  current,
  orgs,
}: {
  current: { kind: 'personal' } | { kind: 'org'; orgId: string; name: string }
  orgs: SwitcherOrg[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const label = current.kind === 'org' ? current.name : 'Personal'

  async function switchTo(organizationId: string | null) {
    if (busy) return
    setBusy(true)
    try {
      await mutate('/api/orgs/current', 'POST', { organization_id: organizationId })
      toast(organizationId ? 'Workspace switched ✓' : 'Back to your personal workspace', {
        tone: 'success',
      })
      router.refresh()
    } catch {
      toast('Could not switch workspace.', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const activeId = current.kind === 'org' ? current.orgId : null

  return (
    <DropdownMenu
      trigger={
        <button
          type="button"
          disabled={busy}
          aria-label={`Current workspace: ${label}. Open workspace switcher`}
          className="flex h-9 max-w-40 items-center gap-1.5 rounded-full border border-slate-200 bg-surface px-3 text-sm font-medium text-ink hover:border-brand disabled:opacity-60"
        >
          <IconUsers className="size-4 shrink-0 text-ink-secondary" />
          <span className="truncate">{label}</span>
          <span aria-hidden className="text-xs text-ink-secondary">
            ▾
          </span>
        </button>
      }
    >
      <DropdownItem
        onSelect={() => switchTo(null)}
        className={activeId === null ? 'font-semibold text-brand' : undefined}
      >
        Personal {activeId === null ? '✓' : ''}
      </DropdownItem>
      {orgs.map((org) => (
        <DropdownItem
          key={org.id}
          onSelect={() => switchTo(org.id)}
          className={activeId === org.id ? 'font-semibold text-brand' : undefined}
        >
          <span className="truncate">{org.name}</span>
          <span className="ml-1 text-xs text-ink-secondary">({org.role})</span>
          {activeId === org.id ? ' ✓' : ''}
        </DropdownItem>
      ))}
      <DropdownItem onSelect={() => router.push('/dashboard/settings#workspace')}>
        + New organization…
      </DropdownItem>
    </DropdownMenu>
  )
}
