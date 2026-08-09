'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Badge } from '@/ui/badge'
import { ConfirmModal } from '@/ui/modal'
import { useToast } from '@/ui/toaster'
import { ApiError, mutate } from '@/lib/api-client'

export interface AiState {
  status: 'active' | 'error'
  model: string
  keyHint: string | null
  /** Phase 4 (docs/11 §3): which level the effective key comes from. */
  level?: 'org' | 'personal'
}

/**
 * Settings → AI (BYOK) — docs/02 §8.3, docs/10 §1/§6–7. Write-only surface:
 * saved keys are never shown back, only the masked hint; disconnect deletes instantly.
 * `readOnly` (org workspace without integrations.manage, or a personal-fallback
 * key) hides the connect/disconnect controls — the server enforces regardless.
 */
export function AiKeySection({
  ai,
  readOnly = false,
  readOnlyReason = null,
}: {
  ai: AiState | null
  readOnly?: boolean
  readOnlyReason?: string | null
}) {
  const router = useRouter()
  const toast = useToast()
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  async function connect() {
    if (!apiKey.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await mutate('/api/integrations/ai', 'POST', { api_key: apiKey.trim() })
      setApiKey('')
      toast('Gemini key verified — AI features are on', { tone: 'success' })
      router.refresh()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the key.')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setConfirmDisconnect(false)
    setBusy(true)
    try {
      await mutate('/api/integrations/ai', 'DELETE')
      toast('AI disconnected — key deleted', { tone: 'info' })
      router.refresh()
    } catch {
      toast('Could not disconnect', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI (BYOK)</CardTitle>
        {ai ? (
          <Badge tone={ai.status === 'active' ? 'success' : 'warning'}>
            {ai.status === 'active' ? `active · ${ai.model}` : 'needs attention'}
          </Badge>
        ) : (
          <Badge tone="muted">optional</Badge>
        )}
        {ai?.level ? (
          <Badge tone="muted">{ai.level === 'org' ? 'organization' : 'personal'}</Badge>
        ) : null}
      </CardHeader>

      {readOnly ? (
        <p className="mb-2 text-sm text-ink-secondary">{readOnlyReason ?? 'Managed elsewhere.'}</p>
      ) : null}

      {ai?.status === 'error' ? (
        <p className="mb-2 rounded-lg bg-warning/10 p-2 text-sm text-warning">
          Your key was rejected — reconnect a fresh one. AI features are paused; everything else
          still works.
        </p>
      ) : null}

      <p className="text-sm text-ink-secondary">
        Paste a free{' '}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand underline"
        >
          Google AI Studio key
        </a>{' '}
        to unlock resume parsing, candidate summaries, and draft assistance. Calls are billed to
        your own key (
        <a
          href="https://ai.google.dev/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand underline"
        >
          pricing
        </a>
        ); resume text is sent to Google only when you press an AI button. Everything works without
        AI.
      </p>

      {readOnly && ai ? (
        <p className="mt-3 text-xs text-ink-secondary">
          Key {ai.keyHint ?? 'saved'} · never shown back
        </p>
      ) : null}

      {!readOnly ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void connect()
          }}
        >
          <div className="flex gap-2">
            <div className="flex-1">
              <Input
                label="Gemini API key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={ai ? `Saved key ${ai.keyHint ?? ''} — paste to replace` : 'AIza…'}
                error={error ?? undefined}
              />
            </div>
            <div className="self-end">
              <Button type="submit" loading={busy} disabled={!apiKey.trim()}>
                {ai ? 'Replace key' : 'Connect'}
              </Button>
            </div>
          </div>
        </form>
      ) : null}

      {!readOnly && ai ? (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-ink-secondary">
            Key {ai.keyHint ?? 'saved'} · never shown back
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmDisconnect(true)}
          >
            Disconnect
          </Button>
        </div>
      ) : null}

      <ConfirmModal
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect AI?"
        description="Your Gemini key is deleted immediately. AI buttons stop working until you add a key again — the rest of HireLink is unaffected."
        confirmLabel="Disconnect"
        loading={busy}
        onConfirm={() => void disconnect()}
      />
    </Card>
  )
}
