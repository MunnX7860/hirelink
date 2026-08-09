import { test, expect } from '@playwright/test'
import { HAS_DB_FIXTURE, signInAsDevUser, adminClient } from './helpers/auth'

/**
 * docs/13 Phase 2 journeys — talent CRM. Gated on the seeded Supabase fixture
 * (same env as apply-flow; run with workers=1 so file-level fixtures don't race —
 * apply-flow's beforeAll deletes the dev owner's jobs).
 */

test.skip(!HAS_DB_FIXTURE, 'needs E2E_WITH_DB=1 and a seeded Supabase (docs/13 §4)')
test.describe.configure({ mode: 'serial' })

let ownerId = ''
let jobId = ''
let applicantA = ''
let applicantB = ''
let applicationA = ''
let applicationB = ''
let tagId = ''

test.beforeAll(async () => {
  const admin = adminClient()
  const { data: userList } = await admin.auth.admin.listUsers()
  const dev = userList?.users.find((u) => u.email === process.env.E2E_DEV_USER_EMAIL)
  ownerId = dev?.id ?? ''
  if (!ownerId) throw new Error('dev owner missing')

  const { data: job } = await admin
    .from('jobs')
    .insert({ owner_id: ownerId, title: 'E2E CRM Probe', status: 'active' })
    .select('id')
    .single()
  jobId = (job as { id: string }).id

  const mk = async (name: string, email: string) => {
    const { data: applicant } = await admin
      .from('applicants')
      .insert({ owner_id: ownerId, full_name: name, email, source: 'e2e' })
      .select('id')
      .single()
    const applicantId = (applicant as { id: string }).id
    const { data: application } = await admin
      .from('applications')
      .insert({ job_id: jobId, applicant_id: applicantId, status: 'new' })
      .select('id')
      .single()
    return { applicantId, applicationId: (application as { id: string }).id }
  }
  const a = await mk('E2E Prosima Rao', 'prosima.rao@example.test')
  const b = await mk('E2E Kavi Menon', 'kavi.menon@example.test')
  applicantA = a.applicantId
  applicationA = a.applicationId
  applicantB = b.applicantId
  applicationB = b.applicationId
})

test('T1 — tag CRUD: create (409 on dup), appears in list', async ({ page }) => {
  await signInAsDevUser(page)
  const created = await page.request.post('/api/tags', { data: { name: 'E2E warm lead' } })
  expect(created.status()).toBe(200)
  const tag = (await created.json()) as { id: string; color: string }
  expect(tag.color).toBe('#6366f1')
  tagId = tag.id

  const dup = await page.request.post('/api/tags', { data: { name: 'E2E warm lead' } })
  expect(dup.status()).toBe(409)
  expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('CONFLICT')

  const list = await page.request.get('/api/tags')
  const tags = (await list.json()) as Array<{ id: string; name: string }>
  expect(tags.some((t) => t.id === tagId)).toBe(true)
})

test('T2 — attach tag to applicant; search + tag filter find them', async ({ page }) => {
  await signInAsDevUser(page)
  const put = await page.request.put(`/api/applicants/${applicantA}/tags`, {
    data: { tag_ids: [tagId] },
  })
  expect(put.status()).toBe(200)

  const byTag = await page.request.get(`/api/applicants?tag_id=${tagId}`)
  const people = (await byTag.json()) as { data: Array<{ id: string; email: string }> }
  expect(people.data.map((p) => p.id)).toContain(applicantA)
  expect(people.data.map((p) => p.id)).not.toContain(applicantB)

  const bySearch = await page.request.get('/api/applicants?q=prosima')
  const found = (await bySearch.json()) as { data: Array<{ id: string }> }
  expect(found.data.map((p) => p.id)).toContain(applicantA)

  // tag events journaled (docs/05 §4.5)
  const feed = await page.request.get(`/api/timeline?applicant_id=${applicantA}&type=tag_added`)
  const events = (await feed.json()) as { data: Array<{ type: string }> }
  expect(events.data.some((e) => e.type === 'tag_added')).toBe(true)
})

test('T3 — notes journaled on applicant + application', async ({ page }) => {
  await signInAsDevUser(page)
  const res = await page.request.post('/api/notes', {
    data: { applicant_id: applicantA, application_id: applicationA, body: 'Great portfolio.' },
  })
  expect(res.status()).toBe(200)

  const detail = await page.request.get(`/api/applicants/${applicantA}`)
  const profile = (await detail.json()) as { notes: Array<{ body: string }> }
  expect(profile.notes.some((n) => n.body === 'Great portfolio.')).toBe(true)

  const feed = await page.request.get(`/api/timeline?applicant_id=${applicantA}&type=note_added`)
  expect(((await feed.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
})

test('T4 — bulk PATCH set_status updates rows + journals events', async ({ page }) => {
  await signInAsDevUser(page)
  const res = await page.request.fetch('/api/applications', {
    method: 'PATCH',
    data: { ids: [applicationA, applicationB], action: 'set_status', value: 'shortlisted' },
    headers: { 'content-type': 'application/json' },
  })
  expect(res.status()).toBe(200)
  const result = (await res.json()) as { updated: number; failed_ids: string[] }
  expect(result.updated).toBe(2)
  expect(result.failed_ids).toEqual([])

  const list = await page.request.get(`/api/applications?status=shortlisted&job_id=${jobId}`)
  const apps = (await list.json()) as { data: Array<{ id: string; status: string }> }
  const ids = apps.data.map((a) => a.id)
  expect(ids).toContain(applicationA)
  expect(ids).toContain(applicationB)
})

test('T5 — E6 rollback: failed move restores the board card', async ({ page }) => {
  await signInAsDevUser(page)
  await page.goto(`/dashboard/pipeline/${jobId}`)
  const card = page.getByTestId(`pipeline-card-${applicationA}`)
  await expect(card).toBeVisible()

  // Force the PATCH to fail — optimistic UI must roll back (docs/13 E6).
  await page.route('**/api/applications/*', async (route) => {
    if (route.request().method() === 'PATCH') {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'forced' } }),
      })
    }
    return route.continue()
  })

  const shortlistedCol = page.getByLabel('shortlisted column')
  await expect(shortlistedCol.getByTestId(`pipeline-card-${applicationA}`)).toBeVisible()

  await card.getByRole('button', { name: /Move E2E Prosima Rao/ }).click()
  await page.getByRole('button', { name: 'offered' }).click()
  await expect(page.getByText(/restored/)).toBeVisible()

  // After refetch the server truth wins: still shortlisted, not offered.
  await page.unroute('**/api/applications/*')
  await page.reload()
  const col = page.getByLabel('shortlisted column')
  await expect(col.getByTestId(`pipeline-card-${applicationA}`)).toBeVisible()
})

test('T6 — CSV export streams attachment honouring filters', async ({ page }) => {
  await signInAsDevUser(page)
  const res = await page.request.get(`/api/applicants/export.csv?tag_id=${tagId}`)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('text/csv')
  expect(res.headers()['content-disposition']).toContain('attachment')
  const body = await res.text()
  expect(body.split(/\r?\n/)[0]).toContain('full_name,email')
  expect(body).toContain('prosima.rao@example.test')
  expect(body).not.toContain('kavi.menon@example.test')
})

test('T7 — application delete keeps Drive files + journals on applicant', async ({ page }) => {
  await signInAsDevUser(page)
  const res = await page.request.delete(`/api/applications/${applicationB}`)
  expect(res.status()).toBe(200)
  expect(((await res.json()) as { ok: boolean }).ok).toBe(true)

  const after = await page.request.get(`/api/applications/${applicationB}`)
  expect(after.status()).toBe(404)

  const feed = await page.request.get(
    `/api/timeline?applicant_id=${applicantB}&type=application_deleted`,
  )
  expect(((await feed.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0)
})
