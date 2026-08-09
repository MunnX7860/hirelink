import { describe, it, expect } from 'vitest'
import { checkRateLimit, clientIp } from '@/lib/ratelimit'

/** Rate limiting — docs/05 §3 env-gated semantics. */
describe('rate limiter (docs/05 §3)', () => {
  it('disabled mode (no Upstash env) always succeeds with infinite remaining', async () => {
    const result = await checkRateLimit('apply:1.2.3.4', 5, 600)
    expect(result.success).toBe(true)
    if (result.success) expect(result.remaining).toBe(Number.POSITIVE_INFINITY)
  })

  it('clientIp prefers first x-forwarded-for entry', () => {
    const req = new Request('http://x', { headers: { 'x-forwarded-for': ' 9.9.9.9 , 10.0.0.1' } })
    expect(clientIp(req)).toBe('9.9.9.9')
  })
  it('clientIp falls back to x-real-ip then unknown', () => {
    expect(clientIp(new Request('http://x', { headers: { 'x-real-ip': '8.8.8.8' } }))).toBe(
      '8.8.8.8',
    )
    expect(clientIp(new Request('http://x'))).toBe('unknown')
  })
})
