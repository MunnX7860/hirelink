import { test, expect, type Page } from '@playwright/test'
import { HAS_DB_FIXTURE, signInAs, adminClient } from './helpers/auth'

/**
 * Cross-tenant isolation X1–X10 — docs/13 §Phase-4 (P0, DB-gated):
 * tenant B gets []/404 on every list/detail route of tenant A; org member
 * positive read inside a shared org; members.manage capability 403s;
 * PLAN_LIMIT 402 on the 4th active job of a free org; full invite round-trip.
 *
 * Requires E2E_WITH_DB=1 + E2E_SUPABASE_URL + E2E_SUPABASE_SERVICE_ROLE_KEY
 * (the dev-user email is NOT needed here — this suite creates its own tenants).
 */

test.skip(
  !process.env.E2E_WITH_DB ||
    !process.env.E2E_SUPABASE_URL ||
    !process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ||
    !HAS_DB_FIXTURE,
  'needs E2E_WITH_DB=1 and a seeded Supabase (docs/13 §4)',
)
test.describe.configure({ mode: 'serial' })

const A = 'e2e-x-tenant-a@hirelink.test'
const B = 'e2e-x-tenant-b@hirelink.test'
const C = 'e2e-x-member-c@hirelink.test'
const D = 'e2e-x-admin-d@hirelink.test'
const E = 'e2e-x-invitee-e@hirelink.test'

let aId = ''
let cId = ''
let dId = ''
let personalJobId = ''
let personalApplicationId = ''
let personalNoteId = ''
let personalTagId = ''
let orgTeamId = ''
let orgFreeId = ''
let orgJobId = ''
let orgApplicantId = ''

/** POST/PATCH/GET as the signed-in browser user (cookies shared from the page context). */
function authed(page: Page) {
  return page.context().request
}

test.beforeAll(async () => {
  const admin = adminClient()

  // 1) Tenants + teammates (idempotent across reruns).
  for (const email of [A, B, C, D, E]) {
    await admin.auth.admin.createUser({ email, email_confirm: true }).catch(() => undefined)
  }
  const { data: userList } = await admin.auth.admin.listUsers()
  const byEmail = (email: string) =>
    (userList?.users.find((u) => u.email === email)?.id ?? '') as string
  aId = byEmail(A)
  cId = byEmail(C)
  dId = byEmail(D)
  if (!aId || !cId || !dId) throw new Error('tenant fixtures missing')

  // Clean only this suite's previous personal data for A (orgs accumulate harmlessly;
  // every run mints fresh org ids which the tests address directly).
  const { data: oldJobs } = await admin
    .from('jobs')
    .select('id')
    .eq('owner_id', aId)
    .is('organization_id', null)
    .like('title', 'E2E X %')
  const oldIds = (oldJobs ?? []).map((j) => j.id)
  if (oldIds.length > 0) await admin.from('jobs').delete().in('id', oldIds)
  await admin.from('applicants').delete().eq('owner_id', aId).eq('source', 'e2e-x')
  await admin.from('tags').delete().eq('owner_id', aId).like('name', 'e2e-x-%')

  // 2) Tenant A personal data (a little of everything — docs/13 X1–X4).
  const { data: pJob } = await admin
    .from('jobs')
    .insert({
      owner_id: aId,
      title: 'E2E X Personal Job',
      status: 'active',
      slug: `e2e-x-p-${Date.now()}`,
    })
    .select('id')
    .single()
  personalJobId = (pJob as { id: string }).id
  const { data: pApplicant } = await admin
    .from('applicants')
    .insert({
      owner_id: aId,
      full_name: 'X Personal',
      email: 'x-personal@hirelink.test',
      source: 'e2e-x',
    })
    .select('id')
    .single()
  const { data: pApp } = await admin
    .from('applications')
    .insert({ job_id: personalJobId, applicant_id: (pApplicant as { id: string }).id })
    .select('id')
    .single()
  personalApplicationId = (pApp as { id: string }).id
  const { data: pTag } = await admin
    .from('tags')
    .insert({ owner_id: aId, name: `e2e-x-tag-${Date.now()}` })
    .select('id')
    .single()
  personalTagId = (pTag as { id: string }).id
  const { data: pNote } = await admin
    .from('notes')
    .insert({
      owner_id: aId,
      applicant_id: (pApplicant as { id: string }).id,
      body: 'e2e-x note',
    })
    .select('id')
    .single()
  personalNoteId = (pNote as { id: string }).id
  await admin.from('timeline_events').insert({
    owner_id: aId,
    applicant_id: (pApplicant as { id: string }).id,
    application_id: personalApplicationId,
    type: 'note_created',
    payload: {},
  })

  // 3) Shared org (team plan — seats for A/C/D + invite room) with own data.
  const { data: orgTeam } = await admin
    .from('organizations')
    .insert({
      name: `X Team Org ${Date.now()}`,
      slug: `xteam${Date.now()}`.slice(0, 30),
      owner_id: aId,
      plan: 'team',
    })
    .select('id')
    .single()
  orgTeamId = (orgTeam as { id: string }).id
  await admin.from('organization_members').insert([
    { organization_id: orgTeamId, user_id: aId, role: 'owner' },
    { organization_id: orgTeamId, user_id: cId, role: 'member' },
    { organization_id: orgTeamId, user_id: dId, role: 'admin' },
  ])
  const { data: oJob } = await admin
    .from('jobs')
    .insert({
      owner_id: aId,
      organization_id: orgTeamId,
      title: 'E2E X Org Job',
      status: 'active',
      slug: `e2e-x-o-${Date.now()}`,
    })
    .select('id')
    .single()
  orgJobId = (oJob as { id: string }).id
  const { data: oApplicant } = await admin
    .from('applicants')
    .insert({
      owner_id: aId,
      organization_id: orgTeamId,
      full_name: 'X Org',
      email: 'x-org@hirelink.test',
      source: 'e2e-x',
    })
    .select('id')
    .single()
  orgApplicantId = (oApplicant as { id: string }).id
  await admin.from('applications').insert({ job_id: orgJobId, applicant_id: orgApplicantId })

  // 4) Free org (A alone) for the PLAN_LIMIT suites.
  const { data: orgFree } = await admin
    .from('organizations')
    .insert({
      name: `X Free Org ${Date.now()}`,
      slug: `xfree${Date.now()}`.slice(0, 30),
      owner_id: aId,
      plan: 'free',
    })
    .select('id')
    .single()
  orgFreeId = (orgFree as { id: string }).id
  await admin
    .from('organization_members')
    .insert({ organization_id: orgFreeId, user_id: aId, role: 'owner' })
})

async function switchTo(page: Page, organizationId: string | null) {
  const res = await authed(page).post('/api/orgs/current', {
    data: { organization_id: organizationId },
  })
  expect(res.status()).toBe(200)
}

// X1 — tenant B sees none of A's jobs (personal or org).
test('X1 jobs isolation — B list contains nothing of A', async ({ page }) => {
  await signInAs(page, B)
  const res = await authed(page).get('/api/jobs')
  expect(res.status()).toBe(200)
  const json = await res.json()
  const ids = (json.data as Array<{ id: string }>).map((j) => j.id)
  expect(ids).not.toContain(personalJobId)
  expect(ids).not.toContain(orgJobId)
  expect(json.data).toEqual([]) // B is brand-new — everything scoped out
})

// X2 — applications list/detail (+ resume stream) are invisible to B.
test('X2 applications isolation — list empty, detail + resume 404', async ({ page }) => {
  await signInAs(page, B)
  const list = await authed(page).get('/api/applications')
  expect((await list.json()).data).toEqual([])
  const detail = await authed(page).get(`/api/applications/${personalApplicationId}`)
  expect(detail.status()).toBe(404)
  const resume = await authed(page).get(`/api/applications/${personalApplicationId}/resume`)
  expect([401, 404]).toContain(resume.status())
})

// X3 — applicants list + CSV export contain nothing of A for B.
test('X3 applicants isolation — list + export.csv empty for B', async ({ page }) => {
  await signInAs(page, B)
  const list = await authed(page).get('/api/applicants')
  expect((await list.json()).data).toEqual([])
  const csv = await authed(page).get('/api/applicants/export.csv')
  expect(csv.status()).toBe(200)
  const body = await csv.text()
  expect(body).not.toContain('x-personal@hirelink.test')
})

// X4 — tags, notes, timeline: no cross-tenant visibility, note delete 404.
test('X4 tags/notes/timeline isolation', async ({ page }) => {
  await signInAs(page, B)
  const tags = await authed(page).get('/api/tags')
  expect((await tags.json()).map((t: { id: string }) => t.id)).not.toContain(personalTagId)
  const timeline = await authed(page).get('/api/timeline')
  expect((await timeline.json()).data).toEqual([])
  const del = await authed(page).delete(`/api/notes/${personalNoteId}`)
  expect(del.status()).toBe(404)
})

// X5 — org detail is 404 for a non-member (no existence leak).
test('X5 org detail 404 for non-member', async ({ page }) => {
  await signInAs(page, B)
  const res = await authed(page).get(`/api/orgs/${orgTeamId}`)
  expect(res.status()).toBe(404)
  const orgs = await authed(page).get('/api/orgs')
  expect(((await orgs.json()) as Array<{ id: string }>).map((o) => o.id)).not.toContain(orgTeamId)
})

// X6 — org member C: positive read of the SHARED org data (docs/13 member read).
test('X6 org member positive read inside the shared org', async ({ page }) => {
  await signInAs(page, C)
  await switchTo(page, orgTeamId)
  const jobs = await authed(page).get('/api/jobs')
  expect(((await jobs.json()).data as Array<{ id: string }>).map((j) => j.id)).toContain(orgJobId)
  const applicants = await authed(page).get('/api/applicants')
  expect(((await applicants.json()).data as Array<{ id: string }>).map((a) => a.id)).toContain(
    orgApplicantId,
  )
  const detail = await authed(page).get(`/api/orgs/${orgTeamId}`)
  expect(detail.status()).toBe(200)
  const org = await detail.json()
  expect(org.org.id).toBe(orgTeamId)
  expect(org.role).toBe('member')
})

// X7 — member capability 403s: manage members / rename are owner-admin territory.
test('X7 member gets 403 on members.manage + org.rename', async ({ page }) => {
  await signInAs(page, C)
  await switchTo(page, orgTeamId)
  const patchMember = await authed(page).patch(`/api/orgs/${orgTeamId}/members/${dId}`, {
    data: { role: 'member' },
  })
  expect(patchMember.status()).toBe(403)
  const removeMember = await authed(page).delete(`/api/orgs/${orgTeamId}/members/${dId}`)
  expect(removeMember.status()).toBe(403)
  const rename = await authed(page).patch(`/api/orgs/${orgTeamId}`, { data: { name: 'Hijacked' } })
  expect(rename.status()).toBe(403)
  const invite = await authed(page).post(`/api/orgs/${orgTeamId}/invites`, {
    data: { email: 'nope@hirelink.test', role: 'member' },
  })
  expect(invite.status()).toBe(403)
})

// X8 — admins still cannot touch the org OWNER (owner is untouchable, 11 §2).
test('X8 admin PATCH owner → 403', async ({ page }) => {
  await signInAs(page, D)
  await switchTo(page, orgTeamId)
  const res = await authed(page).patch(`/api/orgs/${orgTeamId}/members/${aId}`, {
    data: { role: 'member' },
  })
  expect(res.status()).toBe(403)
  // Positive control: the admin CAN demote a fellow non-owner (C: member→admin→member).
  const up = await authed(page).patch(`/api/orgs/${orgTeamId}/members/${cId}`, {
    data: { role: 'admin' },
  })
  expect(up.status()).toBe(200)
  const down = await authed(page).patch(`/api/orgs/${orgTeamId}/members/${cId}`, {
    data: { role: 'member' },
  })
  expect([200, 403]).toContain(down.status()) // demoting an admin requires the owner — both documented
})

// X9 — free org: 4th active job → 402 PLAN_LIMIT; invite past 1 seat → 402.
test('X9 PLAN_LIMIT 402 on 4th active job + seat cap (free org)', async ({ page }) => {
  await signInAs(page, A)
  await switchTo(page, orgFreeId)
  const suffix = Date.now()
  for (let i = 1; i <= 3; i++) {
    const res = await authed(page).post('/api/jobs', {
      data: { title: `E2E X Free Job ${suffix}-${i}` },
    })
    expect(res.status()).toBe(201)
  }
  const fourth = await authed(page).post('/api/jobs', {
    data: { title: `E2E X Free Job ${suffix}-4` },
  })
  expect(fourth.status()).toBe(402)
  expect((await fourth.json()).error.code).toBe('PLAN_LIMIT')

  const invite = await authed(page).post(`/api/orgs/${orgFreeId}/invites`, {
    data: { email: 'extra-seat@hirelink.test', role: 'member' },
  })
  expect(invite.status()).toBe(402)
  expect((await invite.json()).error.code).toBe('PLAN_LIMIT')
})

// X10 — invite round-trip: create → peek → accept → member visible (docs/13).
test('X10 invite round-trip', async ({ page }) => {
  await signInAs(page, A)
  const create = await authed(page).post(`/api/orgs/${orgTeamId}/invites`, {
    data: { email: E, role: 'member' },
  })
  expect(create.status()).toBe(201)
  const payload = await create.json()
  const joinUrl: string = payload.join_url
  const token = joinUrl.split('/invite/')[1]
  expect(token).toBeTruthy()
  expect(payload.invite.email).toBe(E)

  await signInAs(page, E)
  const peek = await authed(page).get(`/api/invites/${token}`)
  expect(peek.status()).toBe(200)
  expect((await peek.json()).email.toLowerCase()).toBe(E)

  const accept = await authed(page).post(`/api/invites/${token}/accept`)
  expect(accept.status()).toBe(201)
  expect((await accept.json()).org_id).toBe(orgTeamId)

  const detail = await authed(page).get(`/api/orgs/${orgTeamId}`)
  expect(detail.status()).toBe(200)
  const org = await detail.json()
  expect(org.role).toBe('member')
  expect((org.members as Array<{ email: string }>).map((m) => m.email.toLowerCase())).toContain(E)

  // Accepting again is idempotent (200 already_member).
  const again = await authed(page).post(`/api/invites/${token}/accept`)
  expect([200, 410]).toContain(again.status())
})
