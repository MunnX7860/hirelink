import { test, expect } from '@playwright/test'

/**
 * Phase 4 API guard rails — docs/13 §Phase-4 (always-on, no services needed).
 * Every org/invite route must reject anonymous traffic with the docs/05 §2
 * envelope; the purge cron is feature-gated (404/401 without CRON_SECRET).
 */

const ID = '00000000-0000-0000-0000-000000000000'

const ORG_ROUTES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/api/orgs' },
  { method: 'POST', path: '/api/orgs', body: { name: 'Acme' } },
  { method: 'GET', path: '/api/orgs/current' },
  { method: 'POST', path: '/api/orgs/current', body: { organization_id: null } },
  { method: 'GET', path: `/api/orgs/${ID}` },
  { method: 'PATCH', path: `/api/orgs/${ID}`, body: { name: 'Acme' } },
  { method: 'DELETE', path: `/api/orgs/${ID}` },
  { method: 'POST', path: `/api/orgs/${ID}/restore` },
  { method: 'POST', path: `/api/orgs/${ID}/transfer`, body: { user_id: ID } },
  { method: 'GET', path: `/api/orgs/${ID}/invites` },
  { method: 'POST', path: `/api/orgs/${ID}/invites`, body: { email: 'a@b.co', role: 'member' } },
  { method: 'DELETE', path: `/api/orgs/${ID}/invites/${ID}` },
  { method: 'PATCH', path: `/api/orgs/${ID}/members/${ID}`, body: { role: 'admin' } },
  { method: 'DELETE', path: `/api/orgs/${ID}/members/${ID}` },
  { method: 'GET', path: '/api/invites/dummy-token-peek' },
  { method: 'POST', path: '/api/invites/dummy-token-peek/accept' },
  { method: 'POST', path: `/api/jobs/${ID}/move`, body: { organization_id: null } },
]

for (const route of ORG_ROUTES) {
  test(`${route.method} ${route.path} → 401 envelope when signed out`, async ({ request }) => {
    const res = await request.fetch(route.path, {
      method: route.method,
      ...(route.body !== undefined
        ? { data: route.body, headers: { 'content-type': 'application/json' } }
        : {}),
    })
    expect(res.status()).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
    expect(json.error.request_id).toBeTruthy()
  })
}

test('GET /api/cron/org-purge is gated (401/404 without valid bearer)', async ({ request }) => {
  const res = await request.get('/api/cron/org-purge')
  expect([401, 404]).toContain(res.status())
})

test('invite landing page redirects signed-out visitors to login with ?next', async ({
  request,
}) => {
  const res = await request.get('/invite/some-token', { maxRedirects: 0 })
  expect([307, 308, 302]).toContain(res.status())
  const location = res.headers()['location'] ?? ''
  expect(location).toContain('/login')
  expect(location).toContain('next=')
  expect(location).toContain('%2Finvite%2Fsome-token')
})
