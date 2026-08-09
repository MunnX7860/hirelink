import { createClient } from '@supabase/supabase-js'
import type { Page } from '@playwright/test'

/**
 * E2E auth fixture — docs/13 §4: seeds a session WITHOUT going through Google UI.
 * Uses the service role to generate a magic link for the seeded dev user, then
 * drives the browser through it so cookies are set exactly as in production.
 *
 * Requires (env-gated via E2E_WITH_DB): a running Supabase with migrations applied
 * and E2E_SUPABASE_URL / E2E_SUPABASE_SERVICE_ROLE_KEY / E2E_DEV_USER_EMAIL set.
 */
export const HAS_DB_FIXTURE = Boolean(
  process.env.E2E_WITH_DB &&
  process.env.E2E_SUPABASE_URL &&
  process.env.E2E_SUPABASE_SERVICE_ROLE_KEY &&
  process.env.E2E_DEV_USER_EMAIL,
)

export function adminClient() {
  return createClient(
    process.env.E2E_SUPABASE_URL as string,
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY as string,
    { auth: { persistSession: false } },
  )
}

/**
 * Sign the given user in (creating the account first — idempotent). Phase 4
 * cross-tenant specs need several tenants, so this generalizes the dev-user path.
 */
export async function signInAs(page: Page, email: string) {
  const admin = adminClient()

  // Ensure the user exists (idempotent for reruns).
  await admin.auth.admin.createUser({ email, email_confirm: true }).catch(() => undefined)

  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  if (error || !data.properties?.action_link) throw error ?? new Error('no magic link')

  const url = new URL(data.properties.action_link)
  // Point the action link at the app under test (Supabase generates its own host).
  url.searchParams.set(
    'redirect_to',
    `${process.env.E2E_BASE_URL ?? 'http://localhost:3000'}/dashboard`,
  )
  await page.goto(url.toString())
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 })
}

export async function signInAsDevUser(page: Page) {
  return signInAs(page, process.env.E2E_DEV_USER_EMAIL as string)
}
