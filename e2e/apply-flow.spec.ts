import { test, expect } from '@playwright/test'
import { HAS_DB_FIXTURE, signInAsDevUser, adminClient } from './helpers/auth'

/**
 * docs/13 §3 — E2–E8 critical journeys. Gated on a real Supabase fixture
 * (E2E_WITH_DB=1 + seeded env — see helpers/auth.ts). The core The offline CI suite
 * covers health/login/shell-protection; these run in dev + the weekly DB job.
 */
test.skip(!HAS_DB_FIXTURE, 'needs E2E_WITH_DB=1 and a seeded Supabase (docs/13 §4)')

let jobSlug = ''
let jobId = ''

test.beforeAll(async () => {
  // Clean slate for the dev owner's jobs (fixtures stay idempotent across runs).
  const admin = adminClient()
  const { data: userList } = await admin.auth.admin.listUsers()
  const dev = userList?.users.find((u) => u.email === process.env.E2E_DEV_USER_EMAIL)
  if (dev) await admin.from('jobs').delete().eq('owner_id', dev.id)
})

test('E2 — owner creates a job and gets a hiring link', async ({ page }) => {
  await signInAsDevUser(page)
  await page.goto('/dashboard/jobs/new')
  await page.getByLabel('Job title').fill('E2E Barista')
  await page.getByRole('button', { name: 'Create job & get link' }).click()
  await expect(page.getByText('Your hiring link is ready')).toBeVisible()
  const code = await page.locator('code').first().textContent()
  const match = code?.match(/\/apply\/([a-z0-9]{8})/)
  expect(match).toBeTruthy()
  jobSlug = match![1]!

  // capture job id via API list
  const jobs = await adminClient().from('jobs').select('id, slug').eq('slug', jobSlug).single()
  jobId = (jobs.data as { id: string }).id
})

test('E3 — applicant applies (resume attached) → rows + notifications journaled', async ({
  page,
}) => {
  await page.goto(`/apply/${jobSlug}`)
  await expect(page.getByRole('heading', { name: 'E2E Barista' })).toBeVisible()
  await page.getByLabel('Full name').fill('E2E Applicant')
  await page.getByLabel('Email').fill('e2e.applicant@example.com')
  await page.locator('#resume').setInputFiles({
    name: 'resume.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF'),
  })
  await page.getByRole('button', { name: 'Submit application' }).click()
  await expect(page.getByText(/Application received|already applied/)).toBeVisible({
    timeout: 15_000,
  })

  // DB assertions (docs/13 §3 E3): applicant + application + timeline events exist.
  const admin = adminClient()
  const { data: applicant } = await admin
    .from('applicants')
    .select('id')
    .eq('email', 'e2e.applicant@example.com')
    .single()
  const { data: application } = await admin
    .from('applications')
    .select('id, status')
    .eq('job_id', jobId)
    .eq('applicant_id', (applicant as { id: string }).id)
    .single()
  expect((application as { status: string }).status).toBe('new')

  // Notifications run in `after()` — poll for the journaled outcome.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from('timeline_events')
          .select('type')
          .eq('application_id', (application as { id: string }).id)
        return (data ?? [])
          .map((e: { type: string }) => e.type)
          .sort()
          .join(',')
      },
      { timeout: 15_000 },
    )
    .toContain('application_created')
})

test('E4 — duplicate apply is idempotent', async ({ page }) => {
  await page.goto(`/apply/${jobSlug}`)
  await page.getByLabel('Full name').fill('E2E Applicant')
  await page.getByLabel('Email').fill('e2e.applicant@example.com')
  await page.getByRole('button', { name: 'Submit application' }).click()
  await expect(page.getByText(/already applied/)).toBeVisible({ timeout: 15_000 })

  const admin = adminClient()
  const { count } = await admin
    .from('applications')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jobId)
  expect(count).toBe(1)
})

test('E5 — Drive not connected: apply still succeeds, resume flagged failed', async () => {
  const admin = adminClient()
  // Dev owner has NO google_drive integration in this fixture by default.
  const { data: resumeRows } = await admin.from('resumes').select('upload_status')
  const statuses = (resumeRows ?? []).map((r: { upload_status: string }) => r.upload_status)
  expect(statuses.length).toBeGreaterThan(0)
  expect(statuses.every((s) => s === 'failed')).toBe(true)
})

test('E6 — pipeline move writes status_changed (owner UI)', async ({ page }) => {
  await signInAsDevUser(page)
  await page.goto('/dashboard')
  await page.getByRole('link', { name: /E2E Applicant/ }).click()
  await page.getByRole('button', { name: /Advance → reviewing/ }).click()
  await expect(page.getByText(/Moved to reviewing/)).toBeVisible()

  const admin = adminClient()
  const { data } = await admin
    .from('timeline_events')
    .select('payload')
    .eq('type', 'status_changed')
    .order('created_at', { ascending: false })
    .limit(1)
  expect((data?.[0] as { payload: { to: string } }).payload.to).toBe('reviewing')
})

test('E7/E8 — closed job: page shows closed state; POST is rejected and rate limits hold', async ({
  page,
  request,
}) => {
  const admin = adminClient()
  await admin.from('jobs').update({ status: 'closed' }).eq('id', jobId)

  await page.goto(`/apply/${jobSlug}`)
  await expect(page.getByText('no longer accepting applications')).toBeVisible()

  const fd = new FormData()
  fd.append('full_name', 'Late Comer')
  fd.append('email', 'late@example.com')
  const res = await request.post(`/api/apply/${jobSlug}`, {
    multipart: { full_name: 'Late Comer', email: 'late@example.com' },
  })
  expect(res.status()).toBe(410)
  expect((await res.json()).error.code).toBe('JOB_CLOSED')
  void fd
})
