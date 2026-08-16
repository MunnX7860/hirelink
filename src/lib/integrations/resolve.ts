import 'server-only'

import { OAuth2Client } from 'google-auth-library'
import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'
import { decryptSecret, encryptSecret } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import { GoogleDriveStorage } from '@/lib/storage/google-drive'
import type { StorageProvider } from '@/lib/storage/types'

/**
 * Integration resolution — docs/03 §4 + docs/11 §3 (Phase 4 precedence, normative):
 * within an org workspace, the row with `integrations.organization_id = :org` WINS;
 * otherwise the owner's own (personal, organization_id IS NULL) row is used.
 *
 * Works with EITHER the request-scoped client (RLS, owner routes) or the service
 * client (public apply flow) — the caller chooses; queries here always filter
 * owner/org explicitly (docs/03 §Rules).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js generics differ between user/service clients; rows are cast explicitly below
type Client = SupabaseClient<any>

export interface IntegrationRow {
  id: string
  owner_id: string
  organization_id?: string | null
  type: 'google_drive' | 'telegram' | 'email' | 'ai'
  status: 'active' | 'error' | 'disconnected'
  credentials_encrypted: string | null
  config: Record<string, unknown>
}

/**
 * Resolution ref: `ownerId` = the data owner (job creator / calling user);
 * `orgId` = current org context (or the owning org of the entity in play).
 */
export interface IntegrationRef {
  ownerId: string
  orgId?: string | null
}

const COLS = 'id, owner_id, organization_id, type, status, credentials_encrypted, config'

/** The owner's PERSONAL row for `type` (organization_id IS NULL). Null when none. */
export async function getIntegration(
  client: Client,
  ownerId: string,
  type: IntegrationRow['type'],
): Promise<IntegrationRow | null> {
  const { data, error } = await client
    .from('integrations')
    .select(COLS)
    .eq('owner_id', ownerId)
    .is('organization_id', null)
    .eq('type', type)
    .neq('status', 'disconnected')
    .maybeSingle()
  if (error) throw error
  return (data as unknown as IntegrationRow) ?? null
}

/** The org-level row for `type` (docs/11 §3). Null when none. */
export async function getOrgIntegration(
  client: Client,
  orgId: string,
  type: IntegrationRow['type'],
): Promise<IntegrationRow | null> {
  const { data, error } = await client
    .from('integrations')
    .select(COLS)
    .eq('organization_id', orgId)
    .eq('type', type)
    .neq('status', 'disconnected')
    .maybeSingle()
  if (error) throw error
  return (data as unknown as IntegrationRow) ?? null
}

/**
 * Workspace-precedence resolution (docs/11 §3): org row first, owner's personal
 * row as fallback. `{ row, level }` so callers can label the source in the UI.
 */
export async function getScopedIntegration(
  client: Client,
  ref: IntegrationRef,
  type: IntegrationRow['type'],
): Promise<{ row: IntegrationRow; level: 'org' | 'personal' } | null> {
  if (ref.orgId) {
    const orgRow = await getOrgIntegration(client, ref.orgId, type)
    if (orgRow) return { row: orgRow, level: 'org' }
  }
  const personal = await getIntegration(client, ref.ownerId, type)
  return personal ? { row: personal, level: 'personal' } : null
}

export async function markIntegrationError(client: Client, integrationId: string): Promise<void> {
  await client.from('integrations').update({ status: 'error' }).eq('id', integrationId)
}

/** Decrypted Telegram credentials (never leaves the server — docs/08 §5, docs/11 §3). */
export async function resolveTelegram(
  client: Client,
  ref: IntegrationRef,
): Promise<{
  integrationId: string
  botToken: string
  chatId: string
  level: 'org' | 'personal'
  shared: boolean
} | null> {
  const resolved = await getScopedIntegration(client, ref, 'telegram')
  if (!resolved || resolved.row.status !== 'active') return null
  const { row, level } = resolved

  // Shared platform bot (docs/11 §3): org rows may carry config.shared=true with no
  // stored credential — the token comes from TELEGRAM_SHARED_BOT_TOKEN (env-gated).
  const shared = Boolean((row.config as { shared?: boolean }).shared)
  if (shared) {
    if (!env.TELEGRAM_SHARED_BOT_TOKEN) return null
    const chatId = String((row.config as { chat_id?: string }).chat_id ?? '')
    if (!chatId) return null
    return {
      integrationId: row.id,
      botToken: env.TELEGRAM_SHARED_BOT_TOKEN,
      chatId,
      level,
      shared: true,
    }
  }

  if (!row.credentials_encrypted) return null
  return {
    integrationId: row.id,
    botToken: decryptSecret(row.credentials_encrypted),
    chatId: String((row.config as { chat_id?: string }).chat_id ?? ''),
    level,
    shared: false,
  }
}

/** Drive storage with decrypted OAuth2 credentials — null when not connected (docs/03 §6 degrade). */
export async function resolveDriveStorage(
  client: Client,
  ref: IntegrationRef,
): Promise<{ integrationId: string; storage: StorageProvider; level: 'org' | 'personal' } | null> {
  const resolved = await getScopedIntegration(client, ref, 'google_drive')
  if (!resolved || resolved.row.status !== 'active' || !resolved.row.credentials_encrypted) {
    return null
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null

  const rootFolderId = (resolved.row.config as { root_folder_id?: string }).root_folder_id
  if (!rootFolderId) return null

  const oauth2 = driveOAuthClientFor(client, resolved.row)
  return {
    integrationId: resolved.row.id,
    storage: new GoogleDriveStorage(oauth2, rootFolderId),
    level: resolved.level,
  }
}

/**
 * Google OAuth redirect targets. Drive and Gmail share one Cloud client but need
 * separate callbacks (different scopes, different integration rows), and Google
 * matches the redirect_uri exactly — so BOTH must be registered in the console.
 */
export const GOOGLE_REDIRECT_PATHS = {
  drive: '/api/integrations/google/callback',
  gmail: '/api/integrations/gmail/callback',
} as const
export type GoogleOAuthPurpose = keyof typeof GOOGLE_REDIRECT_PATHS

/** Raw OAuth2 client holder (for refresh persistence — docs/07 §3.3). */
export function buildGoogleOAuthClient(purpose: GoogleOAuthPurpose = 'drive'): OAuth2Client {
  return new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.NEXT_PUBLIC_APP_URL}${GOOGLE_REDIRECT_PATHS[purpose]}`,
  )
}

/**
 * Attaches a `tokens` listener that re-encrypts + persists any refreshed access
 * token — and, when Google rotates it, the refresh token — back onto the
 * integration row (docs/07 §3.3, normative: "always persist returned refresh
 * tokens"). Without this, a Google-side rotation leaves the DB serving a
 * now-invalid refresh token, and the owner hits an unexplained `invalid_grant`.
 */
function attachTokenPersistence(
  oauth2: OAuth2Client,
  client: Client,
  integrationId: string,
  baseCredentials: Record<string, unknown>,
): void {
  let latest = baseCredentials
  oauth2.on('tokens', (tokens) => {
    latest = { ...latest, ...tokens }
    void client
      .from('integrations')
      .update({ credentials_encrypted: encryptSecret(JSON.stringify(latest)) })
      .eq('id', integrationId)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          logger.error('drive token refresh persistence failed', {
            integration_id: integrationId,
            error: error.message,
          })
        }
      })
  })
}

/**
 * Builds a credentialed OAuth2 client for a Drive integration row, wired to
 * persist any token refresh back to that row (docs/07 §3.3). Every call site
 * that talks to Drive on a user's behalf should go through this rather than
 * hand-rolling `buildGoogleOAuthClient()` + `setCredentials()`.
 */
export function driveOAuthClientFor(client: Client, row: IntegrationRow): OAuth2Client {
  if (!row.credentials_encrypted) {
    throw new Error('driveOAuthClientFor: integration row has no stored credentials')
  }
  const oauth2 = buildGoogleOAuthClient('drive')
  const credentials = JSON.parse(decryptSecret(row.credentials_encrypted)) as Record<
    string,
    unknown
  >
  oauth2.setCredentials(credentials)
  attachTokenPersistence(oauth2, client, row.id, credentials)
  return oauth2
}

/**
 * A workspace's connected Gmail sender, or null when none is connected.
 *
 * Stored on the previously-unused `integration_type = 'email'` row, so no
 * migration was needed. Org row wins over personal (docs/11 §3), matching every
 * other integration: a team's shared sending identity should not depend on which
 * member happens to trigger the send.
 */
export async function resolveGmailSender(
  client: Client,
  ref: IntegrationRef,
): Promise<{ integrationId: string; oauth2: OAuth2Client; address: string } | null> {
  const resolved = await getScopedIntegration(client, ref, 'email')
  if (!resolved || resolved.row.status !== 'active' || !resolved.row.credentials_encrypted) {
    return null
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null

  const address = String((resolved.row.config as { address?: string }).address ?? '')
  // Without the address we cannot build a truthful From header — Gmail would
  // rewrite it anyway, so a row missing it is treated as not connected.
  if (!address) return null

  const oauth2 = buildGoogleOAuthClient('gmail')
  const credentials = JSON.parse(decryptSecret(resolved.row.credentials_encrypted)) as Record<
    string,
    unknown
  >
  oauth2.setCredentials(credentials)
  attachTokenPersistence(oauth2, client, resolved.row.id, credentials)
  return { integrationId: resolved.row.id, oauth2, address }
}
