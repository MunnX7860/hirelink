/**
 * Resend webhook signature verification — docs/05 §4.8.
 * Resend uses svix: signature = base64( HMAC-SHA256(secret, `${id}.${ts}.${body}`) ),
 * header `svix-signature` may carry several `v1,<sig>` space-separated entries.
 * Secret arrives as `whsec_<base64>`; the HMAC key is the decoded bytes.
 *
 * Pure + injectable clock so the whole path is unit-testable.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const WEBHOOK_TOLERANCE_SECONDS = 300 // svix default replay window

export interface SvixHeaders {
  id: string | null
  timestamp: string | null
  signature: string | null
}

export function readSvixHeaders(get: (name: string) => string | null): SvixHeaders {
  return {
    id: get('svix-id'),
    timestamp: get('svix-timestamp'),
    signature: get('svix-signature'),
  }
}

function decodeSecret(secret: string): Buffer {
  const b64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  return Buffer.from(b64, 'base64')
}

function timingSafeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function isTimestampFresh(timestamp: string, nowSeconds: number): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  return Math.abs(nowSeconds - ts) <= WEBHOOK_TOLERANCE_SECONDS
}

export function expectedSvixSignature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
): string {
  return createHmac('sha256', decodeSecret(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64')
}

/** Extract all `v1` signatures from the header value (svix may send many). */
export function parseSvixSignatures(header: string | null): string[] {
  if (!header) return []
  return header
    .split(' ')
    .map((part) => {
      const [version, sig] = part.split(',', 2)
      return version === 'v1' && sig ? sig : null
    })
    .filter((s): s is string => Boolean(s))
}

export function verifySvixSignature(input: {
  secret: string
  headers: SvixHeaders
  body: string
  nowSeconds?: number
}): { ok: true } | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' } {
  const { id, timestamp, signature } = input.headers
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!isTimestampFresh(timestamp, now)) return { ok: false, reason: 'stale_timestamp' }

  const expected = expectedSvixSignature(input.secret, id, timestamp, input.body)
  const candidates = parseSvixSignatures(signature)
  const matched = candidates.some((sig) => timingSafeEqualString(sig, expected))
  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' }
}
