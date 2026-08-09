import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '@/lib/env'

/**
 * AES-256-GCM encryption for user credentials at rest — docs/00 D3, docs/07 §3.
 * Stored format: `v1.<b64url iv>.<b64url tag>.<b64url ciphertext>`
 * Key: ENCRYPTION_SECRET (64 hex chars = 32 bytes). Rotating the key requires a
 * re-encrypt task (docs/12 §7). Node runtime only (docs/03 §2).
 */

const VERSION = 'v1'
const IV_BYTES = 12 // GCM standard
const ALGORITHM = 'aes-256-gcm'

function key(): Buffer {
  return Buffer.from(env.ENCRYPTION_SECRET, 'hex')
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('crypto: unrecognized payload format')
  }
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string]
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

/** Masked display hint (e.g. `…a1b2`) — safe to show in UI. Never return raw secrets to clients (docs/05 §4.6). */
export function maskSecret(secret: string): string {
  if (secret.length <= 4) return '…'
  return `…${secret.slice(-4)}`
}
