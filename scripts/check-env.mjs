#!/usr/bin/env node
/**
 * check-env — validates local env setup per docs/12 §3.
 * Reads `.env.local` and reports missing REQUIRED vars (mirrors src/lib/env.ts).
 * Run: `node scripts/check-env.mjs`
 */
import { readFileSync, existsSync } from 'node:fs'

const REQUIRED = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ENCRYPTION_SECRET',
]

const OPTIONAL = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'RESEND_API_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SENTRY_DSN',
  'CRON_SECRET',
]

if (!existsSync('.env.local')) {
  console.error('✖ .env.local not found. Run: cp .env.example .env.local')
  process.exit(1)
}

const raw = readFileSync('.env.local', 'utf8')
const vars = Object.fromEntries(
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]
    }),
)

let failed = false
for (const key of REQUIRED) {
  const value = vars[key]
  const bad = !value || (key === 'ENCRYPTION_SECRET' && !/^[0-9a-f]{64}$/i.test(value))
  console.log(`${bad ? '✖' : '✔'} ${key}${bad ? ' — missing or invalid' : ''}`)
  if (bad) failed = true
}
for (const key of OPTIONAL) {
  console.log(`${vars[key] ? '✔' : '•'} ${key} (optional)`)
}

if (failed) {
  console.error('\nFix the ✖ items. Generate ENCRYPTION_SECRET with: openssl rand -hex 32')
  process.exit(1)
}
console.log('\nEnvironment looks good.')
