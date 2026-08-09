import 'server-only'
import { z } from 'zod'

/**
 * The ONLY file allowed to read `process.env` (docs/14 §2.4).
 * Everything else imports the typed `env` object. Boot fails fast with a named-vars
 * error if anything required is missing (docs/12 §2) — we never run half-configured.
 *
 * Exception: src/middleware.ts + src/lib/supabase/middleware.ts run at the edge and read
 * NEXT_PUBLIC_* from `process.env` directly (inlined at build time; they must not import
 * server-only modules or the service-role key).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- Required (docs/12 §2) ---
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(10),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),
  ENCRYPTION_SECRET: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be 64 hex chars (32 bytes) — `openssl rand -hex 32`'),

  // --- Optional (env-gated features) ---
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(3).default('HireLink <notifications@example.com>'),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  SENTRY_DSN: z.string().url().optional(),
  CRON_SECRET: z.string().min(16).optional(),
  // Vercel-provided (production/preview/development) — used only for CSP discipline.
  VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),
  // Resend svix signing secret (`whsec_…`) — enables POST /api/webhooks/resend (docs/05 §4.8).
  RESEND_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Phase 4 shared org Telegram bot (docs/11 §3) — orgs connect chat-only, token lives here.
  TELEGRAM_SHARED_BOT_TOKEN: z.string().min(10).optional(),
})

export type Env = z.infer<typeof EnvSchema>

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    // Intentionally NOT using lib/logger here: logger depends on nothing, env depends on nothing.
    // Keep boot-failure dependency-free so it always surfaces.
    console.error(`[env] Missing/invalid environment variables:\n${missing}`)
    throw new Error('Invalid environment configuration — see above.')
  }
  return parsed.data
}

export const env: Env = loadEnv()

/** True when an optional integration is configured; use for feature gating. */
export const features = {
  googleDriveOAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  email: Boolean(env.RESEND_API_KEY),
  rateLimit: Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
  sentry: Boolean(env.SENTRY_DSN),
  cron: Boolean(env.CRON_SECRET),
  resendWebhook: Boolean(env.RESEND_WEBHOOK_SECRET),
  /** Phase 4 shared org Telegram bot option (docs/11 §3, org workspaces only). */
  sharedTelegramBot: Boolean(env.TELEGRAM_SHARED_BOT_TOKEN),
  /** Same CSP gate as next.config.ts (which cannot import this module). */
  cspHardening: env.VERCEL_ENV === 'production' || process.env.CSP_FORCE === '1',
} as const
