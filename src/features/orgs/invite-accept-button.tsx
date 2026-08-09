'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/ui/button'
import { useToast } from '@/ui/toaster'
import { ApiError, mutate } from '@/lib/api-client'

/**
 * Accept invite button — docs/02 §10.3. POSTs the accept RPC route, then switches
 * the workspace cookie to the new org and lands on the dashboard.
 */
export function InviteAcceptButton({ token }: { token: string }) {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function accept() {
    if (busy) return
    setBusy(true)
    try {
      const result = await mutate<{
        org_id: string
        org_name: string
        already_member: boolean
      }>(`/api/invites/${encodeURIComponent(token)}/accept`, 'POST')
      // Land inside the new workspace (docs/02 §10.3).
      try {
        await mutate('/api/orgs/current', 'POST', { organization_id: result.org_id })
      } catch {
        // Non-fatal — the switcher in the top bar can switch later.
      }
      toast(
        result.already_member
          ? `You’re already in ${result.org_name} — switched over ✓`
          : `Welcome to ${result.org_name} 🎉`,
        { tone: 'success' },
      )
      router.push('/dashboard')
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not accept the invite.', {
        tone: 'danger',
      })
      setBusy(false)
    }
  }

  return (
    <Button onClick={accept} loading={busy} className="w-full">
      Accept & join workspace
    </Button>
  )
}
