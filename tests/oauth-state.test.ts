import { describe, it, expect, vi } from 'vitest'
import { createOAuthState, verifyOAuthState } from '@/lib/oauth-state'

/** OAuth state HMAC — docs/07 §2. */
describe('OAuth state (docs/07 §2)', () => {
  it('round-trips ownerId + nonce', () => {
    const { state, nonce } = createOAuthState('user-123')
    const payload = verifyOAuthState(state)
    expect(payload?.ownerId).toBe('user-123')
    expect(payload?.nonce).toBe(nonce)
  })

  it('rejects tampered payloads (HMAC mismatch)', () => {
    const { state } = createOAuthState('user-123')
    const [serialized] = state.split('.')
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ownerId: 'attacker', nonce: 'x', ts: Date.now() }),
      'utf8',
    ).toString('base64url')
    // keep the original signature — must fail verification
    expect(verifyOAuthState(`${tamperedPayload}.${state.split('.')[1]}`)).toBeNull()
    expect(verifyOAuthState(`${serialized}.bogus-signature`)).toBeNull()
    expect(verifyOAuthState('garbage')).toBeNull()
  })

  it('rejects expired states (> 10 min TTL)', () => {
    vi.useFakeTimers()
    const { state } = createOAuthState('user-123')
    vi.advanceTimersByTime(10 * 60 * 1000 + 1000)
    expect(verifyOAuthState(state)).toBeNull()
    vi.useRealTimers()
  })
})
