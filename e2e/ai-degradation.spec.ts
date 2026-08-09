import { test, expect } from '@playwright/test'
import { HAS_DB_FIXTURE, signInAsDevUser } from './helpers/auth'

/**
 * Phase 3 degradation matrix — docs/10 §6. Gated on the seeded DB fixture.
 * Precondition: the dev owner has NO ai integration (delete it in beforeAll to
 * be sure). Key-rejection hits the real Gemini endpoint with an invalid key —
 * deterministic 400 from Google, no quota spent.
 */

test.skip(!HAS_DB_FIXTURE, 'needs E2E_WITH_DB=1 and a seeded Supabase (docs/13 §4)')
test.describe.configure({ mode: 'serial' })

const ZERO = '00000000-0000-0000-0000-000000000000'

test.beforeAll(async () => {
  const { adminClient } = await import('./helpers/auth')
  const admin = adminClient()
  const { data: userList } = await admin.auth.admin.listUsers()
  const dev = userList?.users.find((u) => u.email === process.env.E2E_DEV_USER_EMAIL)
  if (dev) {
    await admin
      .from('integrations')
      .update({ status: 'disconnected', credentials_encrypted: null })
      .eq('owner_id', dev.id)
      .eq('type', 'ai')
  }
})

const AI_ROUTES: Array<{ path: string; body: unknown }> = [
  { path: '/api/ai/parse-resume', body: { resume_id: ZERO } },
  { path: '/api/ai/summarize-applicant', body: { applicant_id: ZERO } },
  { path: '/api/ai/generate/job-description', body: { title: 'Barista' } },
  { path: '/api/ai/generate/social-post', body: { job_id: ZERO } },
]

test('A1 — every AI feature returns 400 AI_NOT_CONFIGURED without a key', async ({ page }) => {
  await signInAsDevUser(page)
  for (const route of AI_ROUTES) {
    const res = await page.request.post(route.path, { data: route.body })
    expect(res.status(), route.path).toBe(400)
    const json = await res.json()
    expect(json.error.code, route.path).toBe('AI_NOT_CONFIGURED')
  }
})

test('A2 — settings shows the AI connect card (degraded state)', async ({ page }) => {
  await signInAsDevUser(page)
  await page.goto('/dashboard/settings')
  await expect(page.getByText('AI (BYOK)')).toBeVisible()
  await expect(page.getByLabel('Gemini API key')).toBeVisible()
})

test('A3 — invalid key is rejected at connect and NOT stored', async ({ page }) => {
  await signInAsDevUser(page)
  const res = await page.request.post('/api/integrations/ai', {
    data: { api_key: 'AIzaSyInvalidKeyThatWillFailVerification123' },
  })
  // Integration-level failure (Google said no) — 502 per docs/05 §4.7 envelope.
  expect([400, 502]).toContain(res.status())
  const json = await res.json()
  expect(['INTEGRATION_ERROR', 'AI_NOT_CONFIGURED']).toContain(json.error.code)

  const check = await page.request.post('/api/ai/generate/job-description', {
    data: { title: 'Barista' },
  })
  expect(check.status()).toBe(400) // still unconfigured — nothing stored
})

test('A4 — application detail hides the AI slot when unconfigured (docs/06 §4)', async ({
  page,
}) => {
  await signInAsDevUser(page)
  const { adminClient } = await import('./helpers/auth')
  const admin = adminClient()
  const { data } = await admin
    .from('applications')
    .select('id')
    .limit(1)
    .order('applied_at', { ascending: false })
  const appId = (data ?? [])[0]?.id as string | undefined
  test.skip(!appId, 'no seeded application to inspect')
  await page.goto(`/dashboard/applications/${appId}`)
  await expect(page.getByText('AI snapshot')).toHaveCount(0)
})
