import { describe, it, expect } from 'vitest'
import { env, features } from '@/lib/env'

/**
 * Boot env smoke test — test env values come from vitest.config.ts `test.env`
 * (mirrors .env.example). The fail-fast path is covered implicitly: with an invalid
 * ENCRYPTION_SECRET the module would throw at import and this file would fail.
 */
describe('env — boot config (docs/12 §2)', () => {
  it('exposes required vars typed and non-empty', () => {
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toMatch(/^https?:\/\//)
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY.length).toBeGreaterThanOrEqual(10)
    expect(env.ENCRYPTION_SECRET).toMatch(/^[0-9a-f]{64}$/i)
  })

  it('feature flags reflect optional vars (absent in test env)', () => {
    expect(features.email).toBe(false)
    expect(features.rateLimit).toBe(false)
    expect(env.EMAIL_FROM).toContain('@')
  })
})
