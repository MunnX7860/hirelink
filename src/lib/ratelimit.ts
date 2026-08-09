import 'server-only'

import { features } from '@/lib/env'

export type RateLimitResult =
  { success: true; remaining: number } | { success: false; retryAfterSec: number }

/**
 * Rate limiting — docs/05 §3: Upstash fixed window, env-gated.
 * When Upstash env is absent (local dev / CI) limits are skipped and callers surface
 * `x-ratelimit: disabled` — docs/05 §3 makes the disabled mode explicit.
 *
 * The @upstash packages are imported lazily so the disabled path never pays the cost.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  if (!features.rateLimit) return { success: true, remaining: Number.POSITIVE_INFINITY }

  const [{ Ratelimit }, { Redis }] = await Promise.all([
    import('@upstash/ratelimit'),
    import('@upstash/redis'),
  ])
  const limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.fixedWindow(limit, `${windowSec} s`),
    prefix: 'rl',
  })
  const { success, remaining, reset } = await limiter.limit(key)
  if (success) return { success: true, remaining }
  return { success: false, retryAfterSec: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) }
}

/** Client IP for public endpoints — first forwarded entry, else 'unknown' bucket. */
export function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) {
    const first = fwd.split(',')[0]?.trim()
    if (first) return first
  }
  return request.headers.get('x-real-ip') ?? 'unknown'
}
