import { describe, expect, it } from 'vitest'
import {
  expectedSvixSignature,
  isTimestampFresh,
  parseSvixSignatures,
  readSvixHeaders,
  verifySvixSignature,
  WEBHOOK_TOLERANCE_SECONDS,
} from '@/lib/webhooks/resend-signature'

// Realistic whsec format: prefix + base64 key bytes.
const SECRET = `whsec_${Buffer.from('unit-test-hmac-key-32-bytes-padded!').toString('base64')}`
const BODY = JSON.stringify({ type: 'email.bounced', data: { email_id: 'abc' } })
const ID = 'msg_123'

function sign(timestamp: number) {
  return expectedSvixSignature(SECRET, ID, String(timestamp), BODY)
}

describe('svix signature verification (docs/05 §4.8)', () => {
  it('accepts a correctly signed payload', () => {
    const now = 1_754_600_000
    const sig = sign(now)
    const verdict = verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: String(now), signature: `v1,${sig}` },
      body: BODY,
      nowSeconds: now,
    })
    expect(verdict).toEqual({ ok: true })
  })

  it('accepts when the signature header carries multiple v1 entries', () => {
    const now = 1_754_600_000
    const sig = sign(now)
    const verdict = verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: String(now), signature: `v1,AAAA v1,${sig}` },
      body: BODY,
      nowSeconds: now,
    })
    expect(verdict.ok).toBe(true)
  })

  it('rejects a tampered body', () => {
    const now = 1_754_600_000
    const sig = sign(now)
    const verdict = verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: String(now), signature: `v1,${sig}` },
      body: BODY.replace('bounced', 'delivered'),
      nowSeconds: now,
    })
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a stale timestamp (replay window)', () => {
    const now = 1_754_600_000
    const stale = now - WEBHOOK_TOLERANCE_SECONDS - 2
    const sig = expectedSvixSignature(SECRET, ID, String(stale), BODY)
    const verdict = verifySvixSignature({
      secret: SECRET,
      headers: { id: ID, timestamp: String(stale), signature: `v1,${sig}` },
      body: BODY,
      nowSeconds: now,
    })
    expect(verdict).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('rejects missing headers', () => {
    const verdict = verifySvixSignature({
      secret: SECRET,
      headers: { id: null, timestamp: null, signature: null },
      body: BODY,
      nowSeconds: 0,
    })
    expect(verdict).toEqual({ ok: false, reason: 'missing_headers' })
  })

  it('isTimestampFresh bounds the window symmetrically', () => {
    expect(isTimestampFresh('1000', 1000 + WEBHOOK_TOLERANCE_SECONDS)).toBe(true)
    expect(isTimestampFresh('1000', 1000 + WEBHOOK_TOLERANCE_SECONDS + 1)).toBe(false)
    expect(isTimestampFresh('not-a-number', 1000)).toBe(false)
  })

  it('parseSvixSignatures keeps only v1 entries', () => {
    expect(parseSvixSignatures('v1,AAA v1,BBB v0,CCC junk')).toEqual(['AAA', 'BBB'])
    expect(parseSvixSignatures(null)).toEqual([])
  })

  it('readSvixHeaders pulls the three svix names', () => {
    const map = new Map([
      ['svix-id', 'm1'],
      ['svix-timestamp', '7'],
      ['svix-signature', 'v1,S'],
    ])
    expect(readSvixHeaders((n) => map.get(n) ?? null)).toEqual({
      id: 'm1',
      timestamp: '7',
      signature: 'v1,S',
    })
  })
})
