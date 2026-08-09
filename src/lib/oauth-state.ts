import 'server-only'

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * OAuth `state` parameter — docs/07 §2: HMAC-signed `{ owner_id, nonce, ts }`,
 * 10-minute TTL, one-time use (nonce stored server-side and consumed on callback —
 * see integrations google routes).
 */

const TTL_MS = 10 * 60 * 1000

export interface OAuthStatePayload {
  ownerId: string
  nonce: string
  ts: number
  /** Phase 4 (docs/11 §3): when set, the connection is stored as the ORG-level Drive. */
  orgId?: string
}

function sign(serialized: string): string {
  return createHmac('sha256', env.ENCRYPTION_SECRET).update(serialized).digest('base64url')
}

export function createOAuthState(
  ownerId: string,
  orgId?: string | null,
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('base64url')
  const payload: OAuthStatePayload = {
    ownerId,
    nonce,
    ts: Date.now(),
    ...(orgId ? { orgId } : {}),
  }
  const serialized = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return { state: `${serialized}.${sign(serialized)}`, nonce }
}

/** Returns the payload when the signature is valid and not expired; otherwise null. */
export function verifyOAuthState(state: string): OAuthStatePayload | null {
  const dot = state.lastIndexOf('.')
  if (dot <= 0) return null
  const serialized = state.slice(0, dot)
  const expected = sign(serialized)
  const given = state.slice(dot + 1)
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(
      Buffer.from(serialized, 'base64url').toString('utf8'),
    ) as OAuthStatePayload
    if (
      typeof payload.ownerId !== 'string' ||
      typeof payload.nonce !== 'string' ||
      typeof payload.ts !== 'number' ||
      (payload.orgId !== undefined && typeof payload.orgId !== 'string')
    ) {
      return null
    }
    if (Date.now() - payload.ts > TTL_MS) return null
    return payload
  } catch {
    return null
  }
}
