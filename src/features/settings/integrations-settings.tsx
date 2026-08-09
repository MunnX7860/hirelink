'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardHeader, CardTitle } from '@/ui/card'
import { Button } from '@/ui/button'
import { Input } from '@/ui/input'
import { Badge } from '@/ui/badge'
import { ConfirmModal } from '@/ui/modal'
import { useToast } from '@/ui/toaster'
import { api, ApiError, mutate } from '@/lib/api-client'
import { AiKeySection, type AiState } from '@/features/ai/ai-key-section'

/**
 * Integrations settings — docs/02 §8, docs/06 §4.
 * Connect flows never display stored credentials (write-only, docs/05 §4.6).
 */

interface DriveState {
  status: 'active' | 'error'
  level: 'org' | 'personal'
  rootFolderSet: boolean
}
interface TelegramState {
  status: 'active' | 'error'
  level: 'org' | 'personal'
  chatId: string | null
  botUsername: string | null
  shared: boolean
}

/**
 * Phase 4 (docs/11 §3): integrations resolve with workspace precedence — the org
 * row first, the owner's personal row as fallback. In an org workspace only
 * owners/admins (integrations.manage) can change connections; a personal-fallback
 * row is managed from the Personal workspace.
 */
export interface IntegrationsWorkspace {
  kind: 'personal' | 'org'
  orgId: string | null
  canManageIntegrations: boolean
}

export function IntegrationsSettings({
  drive,
  telegram,
  emailConfigured,
  driveOAuthConfigured,
  ai,
  workspace,
  sharedBotAvailable = false,
}: {
  drive: DriveState | null
  telegram: TelegramState | null
  emailConfigured: boolean
  driveOAuthConfigured: boolean
  ai: AiState | null
  workspace: IntegrationsWorkspace
  sharedBotAvailable?: boolean
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Google Drive</CardTitle>
          {drive ? (
            <>
              <Badge tone={drive.status === 'active' ? 'success' : 'warning'}>{drive.status}</Badge>
              <LevelBadge level={drive.level} />
            </>
          ) : null}
        </CardHeader>
        <DriveSection drive={drive} oauthConfigured={driveOAuthConfigured} workspace={workspace} />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Telegram</CardTitle>
          {telegram ? (
            <>
              <Badge tone={telegram.status === 'active' ? 'success' : 'warning'}>
                {telegram.status}
              </Badge>
              <LevelBadge level={telegram.level} />
            </>
          ) : null}
        </CardHeader>
        <TelegramSection
          telegram={telegram}
          workspace={workspace}
          sharedBotAvailable={sharedBotAvailable}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <Badge tone={emailConfigured ? 'success' : 'muted'}>
            {emailConfigured ? 'configured' : 'simulated (dev)'}
          </Badge>
        </CardHeader>
        <p className="text-sm text-ink-secondary">
          Transactional emails (application confirmations, alerts) are sent via the platform’s
          Resend account — nothing to connect here.{' '}
          {emailConfigured
            ? 'Live delivery is enabled.'
            : 'This deployment has no RESEND_API_KEY, so emails are rendered and logged instead (dev mode).'}
        </p>
      </Card>

      <AiKeySection
        ai={ai}
        readOnly={isReadOnly(workspace, ai?.level)}
        readOnlyReason={readOnlyReason(workspace, ai?.level)}
      />
    </>
  )
}

/** Small "organization"/"personal" label showing where a connection lives. */
function LevelBadge({ level }: { level: 'org' | 'personal' }) {
  return <Badge tone="muted">{level === 'org' ? 'organization' : 'personal'}</Badge>
}

/** True when the section's controls should be hidden in the current workspace. */
function isReadOnly(workspace: IntegrationsWorkspace, level?: 'org' | 'personal'): boolean {
  if (workspace.kind === 'personal') return false
  if (!workspace.canManageIntegrations) return true
  return level === 'personal' // personal fallback — managed from the Personal workspace
}

function readOnlyReason(
  workspace: IntegrationsWorkspace,
  level?: 'org' | 'personal',
): string | null {
  if (workspace.kind === 'personal') return null
  if (!workspace.canManageIntegrations)
    return 'Only organization owners and admins can manage organization connections.'
  if (level === 'personal')
    return 'This is your personal connection — switch to the Personal workspace to manage it.'
  return null
}

// ── Drive ─────────────────────────────────────────────────────────────────────

function DriveSection({
  drive,
  oauthConfigured,
  workspace,
}: {
  drive: DriveState | null
  oauthConfigured: boolean
  workspace: IntegrationsWorkspace
}) {
  const router = useRouter()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [pickFolder, setPickFolder] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const reason = readOnlyReason(workspace, drive?.level)

  async function connect() {
    setBusy(true)
    try {
      const { url } = await api<{ url: string }>('/api/integrations/google/start', {
        method: 'POST',
        // Org workspaces connect the SHARED org Drive (docs/11 §3) — explicit org_id.
        ...(workspace.kind === 'org' && workspace.orgId
          ? { body: { org_id: workspace.orgId } }
          : {}),
      })
      window.location.assign(url)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not start the connection.', {
        tone: 'danger',
      })
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await mutate('/api/integrations/google_drive', 'DELETE')
      toast('Google Drive disconnected', { tone: 'info' })
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
      router.refresh()
    } catch {
      toast('Could not disconnect.', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  if (reason) {
    return (
      <div className="flex flex-col gap-2">
        {drive ? (
          <p className="text-sm text-ink-secondary">
            {drive.rootFolderSet ? 'Root folder set.' : 'No root folder chosen yet.'}
          </p>
        ) : null}
        <p className="text-sm text-ink-secondary">{reason}</p>
      </div>
    )
  }

  if (!drive) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-secondary">
          Resumes are stored in{' '}
          <strong>{workspace.kind === 'org' ? 'the organization’s' : 'your'}</strong> Google Drive,
          automatically organised by job. We only request access to files we create.
        </p>
        {!oauthConfigured ? (
          <p className="text-xs text-warning">
            This deployment is missing GOOGLE_CLIENT_* env vars — ask the admin to configure them
            (docs/12 §2).
          </p>
        ) : null}
        <Button
          onClick={connect}
          loading={busy}
          disabled={!oauthConfigured}
          className="w-full sm:w-auto"
        >
          Connect Google Drive
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {drive.status === 'error' ? (
        <p className="text-sm text-warning">
          The connection needs attention — reconnect to keep storing resumes.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {drive.rootFolderSet ? (
          <p className="flex-1 text-sm text-ink-secondary">
            Root folder set — resumes will land inside it.
          </p>
        ) : (
          <>
            <p className="flex-1 text-sm text-ink-secondary">
              Choose where resume folders should live.
            </p>
            <Button variant="secondary" onClick={() => setPickFolder(true)}>
              Choose root folder
            </Button>
          </>
        )}
        {drive.status !== 'active' ? (
          <Button onClick={connect} loading={busy}>
            Reconnect
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setConfirmDisconnect(true)} disabled={busy}>
          Disconnect
        </Button>
      </div>

      <FolderPickerModal open={pickFolder} onOpenChange={setPickFolder} />
      <ConfirmModal
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Google Drive?"
        description="Your files stay in your Drive. New resumes can’t be stored until you reconnect."
        confirmLabel="Disconnect"
        loading={busy}
        onConfirm={disconnect}
      />
    </div>
  )
}

function FolderPickerModal({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const router = useRouter()
  const toast = useToast()
  const [newFolderName, setNewFolderName] = useState('HireLink')
  const [saving, setSaving] = useState(false)

  const folders = useQuery({
    queryKey: ['drive-folders'],
    queryFn: () =>
      api<{ data: Array<{ id: string; name: string }> }>('/api/integrations/google/folders'),
    enabled: open,
    retry: 0,
  })

  async function choose(folderId?: string) {
    setSaving(true)
    try {
      const body = folderId ? { folder_id: folderId } : { create_named: newFolderName }
      await mutate('/api/integrations/google/root-folder', 'POST', body)
      toast('Root folder saved ✓', { tone: 'success' })
      onOpenChange(false)
      router.refresh()
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the folder.', {
        tone: 'danger',
      })
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40" onClick={() => onOpenChange(false)} aria-hidden />
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-md flex-col gap-3 rounded-[12px] bg-surface p-5 shadow-xl">
        <h3 className="text-lg font-semibold text-ink">Choose a root folder</h3>
        <div className="flex gap-2">
          <input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            aria-label="New folder name"
            className="h-11 flex-1 rounded-lg border border-slate-300 px-3 text-base"
          />
          <Button
            onClick={() => choose()}
            loading={saving}
            disabled={newFolderName.trim().length < 2}
          >
            Create
          </Button>
        </div>
        <p className="text-xs text-ink-secondary">…or pick an existing folder:</p>
        <div className="flex flex-col gap-1 overflow-y-auto">
          {folders.isLoading ? (
            <p className="py-4 text-center text-sm text-ink-secondary">Loading folders…</p>
          ) : null}
          {folders.isError ? (
            <p className="py-2 text-sm text-danger">Could not list folders — try Create instead.</p>
          ) : null}
          {folders.data?.data.map((f) => (
            <button
              key={f.id}
              disabled={saving}
              onClick={() => choose(f.id)}
              className="rounded-lg px-3 py-2.5 text-left text-sm text-ink hover:bg-slate-100 disabled:opacity-50"
            >
              📁 {f.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Telegram ──────────────────────────────────────────────────────────────────

function TelegramSection({
  telegram,
  workspace,
  sharedBotAvailable,
}: {
  telegram: TelegramState | null
  workspace: IntegrationsWorkspace
  sharedBotAvailable: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const reason = readOnlyReason(workspace, telegram?.level)

  if (reason) {
    return (
      <div className="flex flex-col gap-2">
        {telegram ? (
          <p className="text-sm text-ink-secondary">
            Alerts go to
            {telegram.shared
              ? ' the shared workspace bot'
              : telegram.botUsername
                ? ` @${telegram.botUsername}`
                : ' your bot'}
            {telegram.chatId ? (
              <>
                {' '}
                · chat <code className="rounded bg-surface-muted px-1">{telegram.chatId}</code>
              </>
            ) : null}
          </p>
        ) : null}
        <p className="text-sm text-ink-secondary">{reason}</p>
      </div>
    )
  }

  function mapErrors(err: unknown) {
    if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
      const mapped: Record<string, string> = {}
      for (const f of ['bot_token', 'chat_id', 'shared']) {
        const m = err.fieldError(f)
        if (m) mapped[f] = m
      }
      setErrors(mapped)
      if (Object.keys(mapped).length === 0) toast(err.message, { tone: 'danger' })
    } else {
      toast(err instanceof ApiError ? err.message : 'Could not connect.', { tone: 'danger' })
    }
  }

  async function save(detect: boolean) {
    setErrors({})
    setBusy(true)
    try {
      const res = await api<{ ok: true; bot_username: string | null; chat_id: string }>(
        '/api/integrations/telegram',
        {
          method: 'POST',
          body: {
            bot_token: token.trim(),
            ...(chatId.trim() ? { chat_id: chatId.trim() } : {}),
            detect,
          },
        },
      )
      toast(`Connected as @${res.bot_username ?? 'your bot'} ✅`, { tone: 'success' })
      setToken('')
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
      router.refresh()
    } catch (err) {
      mapErrors(err)
    } finally {
      setBusy(false)
    }
  }

  /** Shared platform bot (org workspaces only — docs/11 §3): chat_id only, no token. */
  async function saveShared() {
    setErrors({})
    setBusy(true)
    try {
      await api<{ ok: true }>('/api/integrations/telegram', {
        method: 'POST',
        body: { shared: true, chat_id: chatId.trim() },
      })
      toast('Shared bot connected ✅', { tone: 'success' })
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
      router.refresh()
    } catch (err) {
      mapErrors(err)
    } finally {
      setBusy(false)
    }
  }

  async function testMessage() {
    setBusy(true)
    try {
      await mutate('/api/integrations/telegram/test', 'POST')
      toast('Test message sent ✅', { tone: 'success' })
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Test failed.', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await mutate('/api/integrations/telegram', 'DELETE')
      toast('Telegram disconnected', { tone: 'info' })
      router.refresh()
    } catch {
      toast('Could not disconnect.', { tone: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  if (telegram) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-secondary">
          Alerts go to
          {telegram.shared
            ? ' the shared workspace bot'
            : telegram.botUsername
              ? ` @${telegram.botUsername}`
              : ' your bot'}
          {telegram.chatId ? (
            <>
              {' '}
              · chat <code className="rounded bg-surface-muted px-1">{telegram.chatId}</code>
            </>
          ) : null}
        </p>
        {telegram.status === 'error' ? (
          <p className="text-sm text-warning">
            Alerts are failing — check that the bot isn’t blocked.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={testMessage} loading={busy}>
            Send test message
          </Button>
          <Button variant="ghost" onClick={() => setConfirmDisconnect(true)} disabled={busy}>
            Disconnect
          </Button>
        </div>
        <ConfirmModal
          open={confirmDisconnect}
          onOpenChange={setConfirmDisconnect}
          title="Disconnect Telegram?"
          description="You’ll stop getting instant new-applicant alerts."
          confirmLabel="Disconnect"
          loading={busy}
          onConfirm={disconnect}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-secondary">
        <li>
          In Telegram, open <strong>@BotFather</strong> → <code>/newbot</code> → copy the token.
        </li>
        <li>
          Open your new bot and press <strong>START</strong> (so it can message you).
        </li>
        <li>Paste the token below and press Detect my chat.</li>
      </ol>
      <Input
        label="Bot token"
        placeholder="123456:ABC-DEF…"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        error={errors.bot_token}
        autoComplete="off"
      />
      <Input
        label="Chat ID"
        placeholder="Press Detect, or paste a number"
        value={chatId}
        onChange={(e) => setChatId(e.target.value)}
        error={errors.chat_id}
        inputMode="numeric"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => save(true)}
          loading={busy}
          disabled={token.trim().length < 20}
        >
          Detect my chat
        </Button>
        <Button
          onClick={() => save(false)}
          loading={busy}
          disabled={token.trim().length < 20 || !chatId.trim()}
        >
          Connect Telegram
        </Button>
      </div>

      {workspace.kind === 'org' && sharedBotAvailable ? (
        <div className="rounded-lg border border-slate-200 p-3">
          <p className="text-sm font-medium text-ink">…or use the shared HireLink bot</p>
          <p className="mb-2 text-xs text-ink-secondary">
            No token needed — add the shared bot to your channel/group, paste its chat ID above, and
            connect.
          </p>
          <Button variant="secondary" onClick={saveShared} loading={busy} disabled={!chatId.trim()}>
            Connect shared bot
          </Button>
          {errors.shared ? <p className="mt-1 text-xs text-danger">{errors.shared}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
